import { join } from "path";
import { getClaudeSessions, getProjectDetail, type ClaudeSession } from "./lib/scanner";
import { initDB, createBoard, getBoard, setBoardPin, verifyBoardSecret, verifyBoardPin, createFlight, updateFlight, deleteFlight, getFlights, cleanStaleFlights } from "./lib/boards";

const PORT = parseInt(process.env.PORT || "3847");
const POLL_INTERVAL = 2000;
const MODE = (process.env.TRAFFICCONTROL_MODE || "local") as "local" | "remote";

if (MODE === "remote") {
  const dbPath = process.env.DATABASE_URL || "trafficcontrol.sqlite";
  initDB(dbPath);
  // Clean stale flights every minute
  setInterval(() => cleanStaleFlights(10), 60_000);
}

// Track which flights are being shared (local mode)
interface SharedFlight {
  flightId: string;
  boardGuid: string;
  boardSecret: string;
  pid: number;
}
const sharedFlights = new Map<number, SharedFlight>(); // pid -> SharedFlight

// Local config storage
interface LocalConfig {
  boardGuid?: string;
  boardSecret?: string;
  remoteUrl?: string;
}

async function loadLocalConfig(): Promise<LocalConfig> {
  try {
    const configPath = join(process.env.HOME!, ".claude", "trafficcontrol.json");
    const file = Bun.file(configPath);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
  } catch {}
  return {};
}

async function saveLocalConfig(config: LocalConfig) {
  const configPath = join(process.env.HOME!, ".claude", "trafficcontrol.json");
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Board-Pin, X-Board-Secret",
  };
}

// Remote mode: board/flight API routes
async function handleRemoteAPI(req: Request, url: URL): Promise<Response | null> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // POST /api/boards - Create a new board
  if (url.pathname === "/api/boards" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const board = createBoard(body.pin);
    return jsonResponse({ guid: board.guid, secret: board.secret, pin: board.pin });
  }

  // GET /api/boards/:guid
  const boardMatch = url.pathname.match(/^\/api\/boards\/([a-f0-9-]+)$/);
  if (boardMatch && req.method === "GET") {
    const guid = boardMatch[1];
    const board = getBoard(guid);
    if (!board) return jsonResponse({ error: "Board not found" }, 404);

    if (board.pin) {
      const pin = req.headers.get("X-Board-Pin");
      if (!pin || !verifyBoardPin(guid, pin)) {
        return jsonResponse({ error: "Invalid PIN", requiresPin: true }, 401);
      }
    }

    return jsonResponse({ guid: board.guid, hasPin: !!board.pin, created_at: board.created_at });
  }

  // PUT /api/boards/:guid/pin
  const pinMatch = url.pathname.match(/^\/api\/boards\/([a-f0-9-]+)\/pin$/);
  if (pinMatch && req.method === "PUT") {
    const guid = pinMatch[1];
    const secret = req.headers.get("X-Board-Secret");
    if (!secret || !verifyBoardSecret(guid, secret)) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    setBoardPin(guid, body.pin || null);
    return jsonResponse({ ok: true });
  }

  // POST /api/boards/:guid/flights - Push a flight
  const flightsPostMatch = url.pathname.match(/^\/api\/boards\/([a-f0-9-]+)\/flights$/);
  if (flightsPostMatch && req.method === "POST") {
    const guid = flightsPostMatch[1];
    const secret = req.headers.get("X-Board-Secret");
    if (!secret || !verifyBoardSecret(guid, secret)) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const flight = createFlight(guid, body);
    return jsonResponse(flight);
  }

  // GET /api/boards/:guid/flights - Get all flights
  if (flightsPostMatch && req.method === "GET") {
    const guid = flightsPostMatch[1];
    const board = getBoard(guid);
    if (!board) return jsonResponse({ error: "Board not found" }, 404);

    if (board.pin) {
      const pin = req.headers.get("X-Board-Pin");
      if (!pin || !verifyBoardPin(guid, pin)) {
        return jsonResponse({ error: "Invalid PIN", requiresPin: true }, 401);
      }
    }

    const flights = getFlights(guid);
    return jsonResponse(flights);
  }

  // PUT /api/boards/:guid/flights/:flightId
  const flightUpdateMatch = url.pathname.match(/^\/api\/boards\/([a-f0-9-]+)\/flights\/([a-f0-9-]+)$/);
  if (flightUpdateMatch && req.method === "PUT") {
    const [, guid, flightId] = flightUpdateMatch;
    const secret = req.headers.get("X-Board-Secret");
    if (!secret || !verifyBoardSecret(guid, secret)) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const flight = updateFlight(flightId, guid, body);
    if (!flight) return jsonResponse({ error: "Flight not found" }, 404);
    return jsonResponse(flight);
  }

  // DELETE /api/boards/:guid/flights/:flightId
  if (flightUpdateMatch && req.method === "DELETE") {
    const [, guid, flightId] = flightUpdateMatch;
    const secret = req.headers.get("X-Board-Secret");
    if (!secret || !verifyBoardSecret(guid, secret)) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }
    const ok = deleteFlight(flightId, guid);
    if (!ok) return jsonResponse({ error: "Flight not found" }, 404);
    return jsonResponse({ ok: true });
  }

  return null;
}

// Local mode: share/config API routes
async function handleLocalAPI(req: Request, url: URL): Promise<Response | null> {
  // GET /api/config - Get local config (board info)
  if (url.pathname === "/api/config" && req.method === "GET") {
    const config = await loadLocalConfig();
    return jsonResponse({
      boardGuid: config.boardGuid || null,
      remoteUrl: config.remoteUrl || null,
      hasBoard: !!config.boardGuid,
    });
  }

  // PUT /api/config - Update local config
  if (url.pathname === "/api/config" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const config = await loadLocalConfig();
    if (body.remoteUrl !== undefined) config.remoteUrl = body.remoteUrl;
    if (body.boardGuid !== undefined) config.boardGuid = body.boardGuid;
    if (body.boardSecret !== undefined) config.boardSecret = body.boardSecret;
    await saveLocalConfig(config);
    return jsonResponse({ ok: true });
  }

  // POST /api/share - Share a flight to remote board
  if (url.pathname === "/api/share" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { pid } = body;
    if (!pid) return jsonResponse({ error: "Missing pid" }, 400);

    let config = await loadLocalConfig();
    const remoteUrl = config.remoteUrl;
    if (!remoteUrl) return jsonResponse({ error: "No remote URL configured. Set it in settings." }, 400);

    // Create board if needed
    if (!config.boardGuid) {
      try {
        const res = await fetch(`${remoteUrl}/api/boards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const board = await res.json() as { guid: string; secret: string };
        config.boardGuid = board.guid;
        config.boardSecret = board.secret;
        await saveLocalConfig(config);
      } catch (e) {
        return jsonResponse({ error: `Failed to create board: ${e}` }, 500);
      }
    }

    // Get current session data for this PID
    const sessions = await getClaudeSessions();
    const session = sessions.find(s => s.pid === pid);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);

    // Get detail data
    const detail = session.project !== "unknown" ? await getProjectDetail(session.project) : {};

    const flightData = {
      project: session.project,
      project_short: session.projectShort,
      pid: session.pid,
      status: session.status,
      cpu: session.cpu,
      mem: session.mem,
      uptime: session.uptime,
      context_tokens: session.contextTokens ?? null,
      context_percent: session.contextPercent ?? null,
      flags: JSON.stringify(session.flags),
      has_agentboard: session.hasAgentboard,
      has_git: session.hasGit,
      git_info: (detail as any).git ? JSON.stringify((detail as any).git) : null,
      agentboard: (detail as any).agentboard ? JSON.stringify((detail as any).agentboard) : null,
      package_info: (detail as any).package ? JSON.stringify((detail as any).package) : null,
      claude_md: (detail as any).claudeMd || null,
    };

    // Check if already shared
    const existing = sharedFlights.get(pid);
    if (existing) {
      // Update existing flight
      try {
        const res = await fetch(`${remoteUrl}/api/boards/${config.boardGuid}/flights/${existing.flightId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Board-Secret": config.boardSecret!,
          },
          body: JSON.stringify(flightData),
        });
        if (!res.ok) throw new Error(await res.text());
        return jsonResponse({ ok: true, flightId: existing.flightId, boardGuid: config.boardGuid, url: `${remoteUrl}/b/${config.boardGuid}` });
      } catch (e) {
        return jsonResponse({ error: `Failed to update flight: ${e}` }, 500);
      }
    }

    // Create new flight
    try {
      const res = await fetch(`${remoteUrl}/api/boards/${config.boardGuid}/flights`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Board-Secret": config.boardSecret!,
        },
        body: JSON.stringify(flightData),
      });
      if (!res.ok) throw new Error(await res.text());
      const flight = await res.json() as { id: string };
      sharedFlights.set(pid, {
        flightId: flight.id,
        boardGuid: config.boardGuid!,
        boardSecret: config.boardSecret!,
        pid,
      });
      return jsonResponse({ ok: true, flightId: flight.id, boardGuid: config.boardGuid, url: `${remoteUrl}/b/${config.boardGuid}` });
    } catch (e) {
      return jsonResponse({ error: `Failed to push flight: ${e}` }, 500);
    }
  }

  // POST /api/unshare - Stop sharing a flight
  if (url.pathname === "/api/unshare" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { pid } = body;
    const shared = sharedFlights.get(pid);
    if (!shared) return jsonResponse({ ok: true });

    const config = await loadLocalConfig();
    const remoteUrl = config.remoteUrl;
    if (remoteUrl && config.boardGuid) {
      try {
        await fetch(`${remoteUrl}/api/boards/${config.boardGuid}/flights/${shared.flightId}`, {
          method: "DELETE",
          headers: { "X-Board-Secret": config.boardSecret! },
        });
      } catch {}
    }
    sharedFlights.delete(pid);
    return jsonResponse({ ok: true });
  }

  // GET /api/shared - Get list of shared PIDs
  if (url.pathname === "/api/shared" && req.method === "GET") {
    const shared: Record<number, string> = {};
    for (const [pid, info] of sharedFlights) {
      shared[pid] = info.flightId;
    }
    return jsonResponse(shared);
  }

  return null;
}

// Periodically push updates for shared flights
async function pushSharedFlightUpdates() {
  if (sharedFlights.size === 0) return;

  const config = await loadLocalConfig();
  if (!config.remoteUrl || !config.boardGuid || !config.boardSecret) return;

  const sessions = await getClaudeSessions();
  const sessionMap = new Map(sessions.map(s => [s.pid, s]));

  for (const [pid, shared] of sharedFlights) {
    const session = sessionMap.get(pid);
    if (!session) {
      // Session gone, remove flight
      try {
        await fetch(`${config.remoteUrl}/api/boards/${config.boardGuid}/flights/${shared.flightId}`, {
          method: "DELETE",
          headers: { "X-Board-Secret": config.boardSecret },
        });
      } catch {}
      sharedFlights.delete(pid);
      continue;
    }

    const detail = session.project !== "unknown" ? await getProjectDetail(session.project) : {};
    const flightData = {
      project: session.project,
      project_short: session.projectShort,
      pid: session.pid,
      status: session.status,
      cpu: session.cpu,
      mem: session.mem,
      uptime: session.uptime,
      context_tokens: session.contextTokens ?? null,
      context_percent: session.contextPercent ?? null,
      flags: JSON.stringify(session.flags),
      has_agentboard: session.hasAgentboard,
      has_git: session.hasGit,
      git_info: (detail as any).git ? JSON.stringify((detail as any).git) : null,
      agentboard: (detail as any).agentboard ? JSON.stringify((detail as any).agentboard) : null,
      package_info: (detail as any).package ? JSON.stringify((detail as any).package) : null,
      claude_md: (detail as any).claudeMd || null,
    };

    try {
      await fetch(`${config.remoteUrl}/api/boards/${config.boardGuid}/flights/${shared.flightId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Board-Secret": config.boardSecret,
        },
        body: JSON.stringify(flightData),
      });
    } catch {}
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight for all API routes
    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Remote mode API
    if (MODE === "remote") {
      const remoteResponse = await handleRemoteAPI(req, url);
      if (remoteResponse) return remoteResponse;
    }

    // Local mode API
    if (MODE === "local") {
      // Session scanning endpoints (local only)
      if (url.pathname === "/api/sessions") {
        const sessions = await getClaudeSessions();
        return jsonResponse(sessions);
      }

      if (url.pathname === "/api/detail") {
        const projectPath = url.searchParams.get("project");
        if (!projectPath) return jsonResponse({ error: "missing project param" }, 400);
        const detail = await getProjectDetail(projectPath);
        return jsonResponse(detail);
      }

      const localResponse = await handleLocalAPI(req, url);
      if (localResponse) return localResponse;
    }

    // Remote mode: board view pages
    if (MODE === "remote") {
      const boardPageMatch = url.pathname.match(/^\/b\/([a-f0-9-]+)$/);
      if (boardPageMatch) {
        return new Response(Bun.file(join(import.meta.dir, "public", "board.html")));
      }
    }

    // Serve index.html
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "index.html")));
    }

    // Serve static files
    const filePath = join(import.meta.dir, "public", url.pathname);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("sessions");
    },
    message() {},
    close(ws) {
      ws.unsubscribe("sessions");
    },
  },
});

// Local mode: broadcast sessions + push shared flights
if (MODE === "local") {
  setInterval(async () => {
    const sessions = await getClaudeSessions();
    server.publish("sessions", JSON.stringify(sessions));
  }, POLL_INTERVAL);

  // Push shared flight updates every 5 seconds
  setInterval(pushSharedFlightUpdates, 5000);
}

// Remote mode: broadcast flights for each board via WebSocket
if (MODE === "remote") {
  setInterval(() => {
    // Remote mode WS broadcasts could be added here
  }, POLL_INTERVAL);
}

console.log(`Traffic Control (${MODE} mode) running at http://localhost:${PORT}`);
