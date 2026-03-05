# Traffic Control

Real-time dashboard for monitoring all your running Claude CLI sessions.

Traffic Control scans your system for active `claude` processes, resolves their working directories, and presents a live-updating dashboard with resource usage, context window consumption, git status, and agentboard integration.

## Features

- **Live session cards** with project name, PID, TTY, CPU/MEM usage, uptime, and status (active/idle)
- **Context window bar** on each card showing token usage as a percentage of the 200k context window (green/amber/red)
- **Sort lock** to freeze card order so they stop jumping around when CPU fluctuates
- **Click-to-expand detail panel** with resizable split view and multiple tabs:
  - **Overview** -- process info, resource meters, git summary, agentboard summary
  - **Git** -- branch, last commit, dirty file count, remote URL
  - **Agentboard** -- full kanban board with backlog/todo/in_progress/done columns
  - **Package** -- name, version, scripts, dependency counts
  - **CLAUDE.md** -- project-level and .claude/projects-level configuration
- **WebSocket push** every 2 seconds for real-time updates without polling
- **Light/dark/system theme** toggle
- **Resizable panels** with drag handle between cards and detail view

## Requirements

- [Bun](https://bun.sh) v1.0+
- macOS (uses `ps aux` and `lsof` for process discovery)

## Install and run

```bash
git clone https://github.com/Kotrotsos/trafficcontrol.git
cd trafficcontrol
bun install
bun start
```

Open http://localhost:3847 in your browser.

## How it works

1. **Process discovery** -- parses `ps aux` output to find all running `claude` CLI processes
2. **Project resolution** -- uses `lsof -Fpn` to inspect each process's open files and infer the project directory
3. **Context tracking** -- reads the most recent assistant message from `.claude/projects/*/\*.jsonl` session files to extract token usage
4. **Enrichment** -- on card click, fetches git info, package.json, CLAUDE.md, and agentboard data from the project directory
5. **Live updates** -- Bun's built-in WebSocket server broadcasts session data to all connected clients every 2 seconds

## Configuration

The server runs on port **3847** by default. Change it in `server.ts`:

```typescript
const PORT = 3847;
```

## Limitations

- macOS only (relies on `ps` and `lsof` output format)
- Local only, since it monitors processes on the host machine
- Context percentage is based on the last assistant message in the most recent session file, which may not reflect the exact live context usage

## License

MIT
