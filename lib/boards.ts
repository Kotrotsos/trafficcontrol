import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

let db: Database;

export interface Board {
  guid: string;
  secret: string;
  pin: string | null;
  created_at: string;
}

export interface Flight {
  id: string;
  board_guid: string;
  project: string;
  project_short: string;
  pid: number;
  status: string;
  cpu: number;
  mem: number;
  uptime: string;
  context_tokens: number | null;
  context_percent: number | null;
  flags: string;
  has_agentboard: boolean;
  has_git: boolean;
  git_info: string | null;
  agentboard: string | null;
  package_info: string | null;
  claude_md: string | null;
  updated_at: string;
}

export function initDB(dbPath?: string) {
  db = new Database(dbPath || "trafficcontrol.sqlite");
  db.run("PRAGMA journal_mode = WAL");

  db.run(`CREATE TABLE IF NOT EXISTS boards (
    guid TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    pin TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS flights (
    id TEXT PRIMARY KEY,
    board_guid TEXT NOT NULL,
    project TEXT,
    project_short TEXT,
    pid INTEGER,
    status TEXT,
    cpu REAL,
    mem REAL,
    uptime TEXT,
    context_tokens INTEGER,
    context_percent INTEGER,
    flags TEXT,
    has_agentboard INTEGER DEFAULT 0,
    has_git INTEGER DEFAULT 0,
    git_info TEXT,
    agentboard TEXT,
    package_info TEXT,
    claude_md TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (board_guid) REFERENCES boards(guid)
  )`);
}

export function createBoard(pin?: string): Board {
  const guid = randomUUID();
  const secret = randomUUID();
  const stmt = db.prepare("INSERT INTO boards (guid, secret, pin) VALUES (?, ?, ?)");
  stmt.run(guid, secret, pin || null);
  return { guid, secret, pin: pin || null, created_at: new Date().toISOString() };
}

export function getBoard(guid: string): Board | null {
  const stmt = db.prepare("SELECT * FROM boards WHERE guid = ?");
  return stmt.get(guid) as Board | null;
}

export function setBoardPin(guid: string, pin: string | null): boolean {
  const stmt = db.prepare("UPDATE boards SET pin = ? WHERE guid = ?");
  const result = stmt.run(pin, guid);
  return result.changes > 0;
}

export function verifyBoardSecret(guid: string, secret: string): boolean {
  const board = getBoard(guid);
  return board !== null && board.secret === secret;
}

export function verifyBoardPin(guid: string, pin: string): boolean {
  const board = getBoard(guid);
  if (!board) return false;
  if (!board.pin) return true;
  return board.pin === pin;
}

export function createFlight(boardGuid: string, data: Partial<Flight>): Flight {
  const id = data.id || randomUUID();
  const stmt = db.prepare(`INSERT INTO flights
    (id, board_guid, project, project_short, pid, status, cpu, mem, uptime,
     context_tokens, context_percent, flags, has_agentboard, has_git,
     git_info, agentboard, package_info, claude_md)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  stmt.run(
    id, boardGuid,
    data.project || "", data.project_short || "",
    data.pid || 0, data.status || "idle",
    data.cpu || 0, data.mem || 0, data.uptime || "",
    data.context_tokens ?? null, data.context_percent ?? null,
    data.flags || "[]",
    data.has_agentboard ? 1 : 0, data.has_git ? 1 : 0,
    data.git_info || null, data.agentboard || null,
    data.package_info || null, data.claude_md || null
  );

  return getFlight(id)!;
}

export function updateFlight(id: string, boardGuid: string, data: Partial<Flight>): Flight | null {
  const existing = db.prepare("SELECT * FROM flights WHERE id = ? AND board_guid = ?").get(id, boardGuid);
  if (!existing) return null;

  const stmt = db.prepare(`UPDATE flights SET
    project = ?, project_short = ?, pid = ?, status = ?, cpu = ?, mem = ?,
    uptime = ?, context_tokens = ?, context_percent = ?, flags = ?,
    has_agentboard = ?, has_git = ?, git_info = ?, agentboard = ?,
    package_info = ?, claude_md = ?, updated_at = datetime('now')
    WHERE id = ? AND board_guid = ?`);

  stmt.run(
    data.project || "", data.project_short || "",
    data.pid || 0, data.status || "idle",
    data.cpu || 0, data.mem || 0, data.uptime || "",
    data.context_tokens ?? null, data.context_percent ?? null,
    data.flags || "[]",
    data.has_agentboard ? 1 : 0, data.has_git ? 1 : 0,
    data.git_info || null, data.agentboard || null,
    data.package_info || null, data.claude_md || null,
    id, boardGuid
  );

  return getFlight(id);
}

export function getFlight(id: string): Flight | null {
  return db.prepare("SELECT * FROM flights WHERE id = ?").get(id) as Flight | null;
}

export function getFlights(boardGuid: string): Flight[] {
  return db.prepare("SELECT * FROM flights WHERE board_guid = ? ORDER BY updated_at DESC").all(boardGuid) as Flight[];
}

export function deleteFlight(id: string, boardGuid: string): boolean {
  const result = db.prepare("DELETE FROM flights WHERE id = ? AND board_guid = ?").run(id, boardGuid);
  return result.changes > 0;
}

export function cleanStaleFlights(maxAgeMinutes: number = 5) {
  db.prepare(`DELETE FROM flights WHERE updated_at < datetime('now', '-' || ? || ' minutes')`).run(maxAgeMinutes);
}
