import { $ } from "bun";
import { join } from "path";
import { execFileSync } from "child_process";
import { readFile, stat, readdir } from "fs/promises";

const CLAUDE_DIR = join(process.env.HOME!, ".claude");
const CONTEXT_WINDOW = 200_000;

export interface ClaudeSession {
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
  hasAgentboard: boolean;
  hasGit: boolean;
  contextTokens?: number;
  contextPercent?: number;
}

export async function getClaudeSessions(): Promise<ClaudeSession[]> {
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

      const status = cpu > 1.0 ? "active" : "idle";
      const uptime = await getUptime(pid);

      const hasAgentboard = project !== "unknown" && await fileExists(join(project, ".agentboard", "board.json"));
      const hasGit = project !== "unknown" && await fileExists(join(project, ".git"));
      const context = project !== "unknown" ? await getContextUsage(project) : undefined;

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
        hasAgentboard,
        hasGit,
        contextTokens: context?.tokens,
        contextPercent: context?.percent,
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

async function getContextUsage(projectPath: string): Promise<{ tokens: number; percent: number } | undefined> {
  try {
    const sanitized = projectPath.replace(/\//g, "-");
    const projDir = join(CLAUDE_DIR, "projects", sanitized);
    const files = await readdir(projDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return undefined;

    let newest = { name: "", mtime: 0 };
    for (const f of jsonlFiles) {
      try {
        const s = await stat(join(projDir, f));
        if (s.mtimeMs > newest.mtime) {
          newest = { name: f, mtime: s.mtimeMs };
        }
      } catch {}
    }
    if (!newest.name) return undefined;

    const filePath = join(projDir, newest.name);
    const fileHandle = Bun.file(filePath);
    const size = fileHandle.size;
    const readSize = Math.min(size, 32768);
    const slice = fileHandle.slice(size - readSize, size);
    const tail = await slice.text();
    const lines = tail.split("\n").filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "assistant" && entry.message?.usage) {
          const u = entry.message.usage;
          const totalInput = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          const totalTokens = totalInput + (u.output_tokens || 0);
          return {
            tokens: totalTokens,
            percent: Math.round((totalTokens / CONTEXT_WINDOW) * 100),
          };
        }
      } catch {}
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function getProjectDetail(projectPath: string) {
  const detail: Record<string, any> = { project: projectPath };

  try {
    const gitExec = (args: string[]) => {
      try {
        return execFileSync("git", ["-c", "color.ui=never", "-C", projectPath, ...args], {
          encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch { return ""; }
    };

    const branch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch) {
      const lastCommit = gitExec(["log", "-1", "--format=%h %s (%ar)"]);
      const status = gitExec(["status", "--porcelain"]);
      const remoteUrl = gitExec(["remote", "get-url", "origin"]).replace(/\.git$/, "");

      detail.git = {
        branch,
        lastCommit,
        dirty: status.length > 0,
        changedFiles: status ? status.split("\n").length : 0,
        remoteUrl: remoteUrl || undefined,
      };
    }
  } catch {}

  try {
    const pkg = JSON.parse(await readFile(join(projectPath, "package.json"), "utf-8"));
    detail.package = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
      dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).length : 0,
      devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0,
    };
  } catch {}

  try {
    const claudeMd = await readFile(join(projectPath, "CLAUDE.md"), "utf-8");
    detail.claudeMd = claudeMd.slice(0, 2000);
  } catch {}

  try {
    const sanitized = projectPath.replace(/\//g, "-");
    const projClaudeMd = await readFile(
      join(process.env.HOME!, ".claude", "projects", sanitized, "CLAUDE.md"), "utf-8"
    );
    detail.projectClaudeMd = projClaudeMd.slice(0, 2000);
  } catch {}

  try {
    const boardJson = await readFile(join(projectPath, ".agentboard", "board.json"), "utf-8");
    detail.agentboard = JSON.parse(boardJson);
  } catch {}

  try {
    const sanitized = projectPath.replace(/\//g, "-");
    const projDir = join(process.env.HOME!, ".claude", "projects", sanitized);
    const files = await readdir(projDir);
    const sessionFiles = files.filter(f => f.endsWith(".jsonl"));
    detail.sessionCount = sessionFiles.length;
  } catch {}

  return detail;
}
