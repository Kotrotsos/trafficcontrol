import { $ } from "bun";
import { join } from "path";
import { execFileSync } from "child_process";

const PORT = 3847;
const POLL_INTERVAL = 2000;

interface ClaudeSession {
  pid: number;
  tty: string;
  cpu: number;
  mem: number;
  startTime: string;
  uptime: string;
  project: string;
  projectShort: string;
  flags: string[];
  status: "active" | "idle";
}

async function getClaudeSessions(): Promise<ClaudeSession[]> {
  try {
    const psOutput =
      await $`ps aux | grep '[c]laude' | grep -v 'Claude.app' | grep -v 'chrome_crashpad' | grep -v 'Claude Helper'`
        .text()
        .catch(() => "");

    const lines = psOutput.trim().split("\n").filter(Boolean);
    const sessions: ClaudeSession[] = [];

    const cliLines = lines.filter(
      (l) => l.includes("claude ") || l.endsWith("claude")
    );

    const pids = cliLines
      .map((l) => {
        const parts = l.trim().split(/\s+/);
        return parseInt(parts[1]);
      })
      .filter((p) => !isNaN(p));

    // Get project directories for all PIDs in one lsof call
    const projectMap = new Map<number, string>();
    if (pids.length > 0) {
      const pidArgs = pids.join(",");
      let lsofOutput = "";
      try {
        lsofOutput = execFileSync("lsof", ["-p", pidArgs, "-Fpn"], {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {}

      let currentPid = 0;
      for (const line of lsofOutput.split("\n")) {
        if (line.startsWith("p")) {
          currentPid = parseInt(line.slice(1));
        } else if (line.startsWith("n/")) {
          const path = line.slice(1);
          if (
            !path.includes("/dev/") &&
            !path.includes("/lib/") &&
            !path.includes("/System/") &&
            !path.includes("/private/") &&
            !path.includes("/usr/") &&
            !path.includes("/var/") &&
            !path.includes("/Applications/") &&
            !path.includes(".local/") &&
            !path.includes(".claude/") &&
            !path.includes(".bun/") &&
            !path.includes("node_modules") &&
            !projectMap.has(currentPid)
          ) {
            // Extract directory from the path
            const dir = path.includes(".")
              ? path.substring(0, path.lastIndexOf("/"))
              : path;
            if (dir && dir !== "/") {
              projectMap.set(currentPid, dir);
            }
          }
        }
      }
    }

    for (const line of cliLines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const startTime = parts[8];
      const tty = parts[6];
      const command = parts.slice(10).join(" ");

      const flags: string[] = [];
      if (command.includes("--resume")) flags.push("resumed");
      if (command.includes("--dangerously-skip-permissions"))
        flags.push("skip-perms");

      const project = projectMap.get(pid) || "unknown";
      const projectShort = project === "unknown" ? "unknown" : project.split("/").slice(-2).join("/");

      // Determine status based on CPU usage
      const status = cpu > 1.0 ? "active" : "idle";

      // Calculate uptime
      const uptime = await getUptime(pid);

      sessions.push({
        pid,
        tty,
        cpu,
        mem,
        startTime,
        uptime,
        project,
        projectShort,
        flags,
        status,
      });
    }

    return sessions;
  } catch (e) {
    console.error("Error getting sessions:", e);
    return [];
  }
}

async function getUptime(pid: number): Promise<string> {
  try {
    const elapsed = await $`ps -o etime= -p ${pid}`.text();
    return elapsed.trim();
  } catch {
    return "unknown";
  }
}

// Serve static files and WebSocket
const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API endpoint (fallback for non-WS clients)
    if (url.pathname === "/api/sessions") {
      const sessions = await getClaudeSessions();
      return Response.json(sessions);
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

// Broadcast session data every POLL_INTERVAL
setInterval(async () => {
  const sessions = await getClaudeSessions();
  server.publish("sessions", JSON.stringify(sessions));
}, POLL_INTERVAL);

console.log(`Traffic Control running at http://localhost:${PORT}`);
