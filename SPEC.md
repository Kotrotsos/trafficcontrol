# Traffic Control - Specification

## Overview

Traffic Control has two modes:

1. **Local mode** - runs on your machine, monitors all Claude CLI sessions in real-time via process inspection (current implementation)
2. **Remote mode** - deployed on Railway, acts as a shared dashboard where you can publish individual "flights" for others to view

The local dashboard is the source of truth. The remote dashboard is for sharing and remote access.

## Concepts

### Board

A board is a shared dashboard instance on the remote server. Each board:

- Has a unique GUID (e.g. `https://trafficcontrol.up.railway.app/b/8a3f2c1d-...`)
- Is created automatically the first time you share a flight
- Can optionally have a PIN code for access control
- Displays all flights that have been shared to it
- Does not require login or authentication, just the GUID (and PIN if set)

### Flight

A flight is a snapshot of a Claude Code session that has been shared to a board. A flight contains:

- Project name and path
- Session status (active/idle)
- CPU/memory usage
- Context window usage (tokens, percentage)
- Uptime and start time
- Flags (resumed, skip-perms, etc.)
- Git info (branch, last commit, dirty status, remote URL) if available
- Agentboard data (kanban board with tasks) if available
- Package info if available
- CLAUDE.md content if available

Flights are pushed from the local dashboard to a remote board. They can be updated continuously (live sharing) or as a one-time snapshot.

### PIN

A board can have a PIN code set by its owner. When a PIN is set:

- Visitors must enter the PIN to view the board
- The PIN is a simple numeric or alphanumeric code
- No user accounts, no login, just the PIN

## Architecture

### Local (Bun server on your machine)

- Monitors all Claude CLI sessions via `ps aux` + `lsof`
- Enriches with context usage from `.claude/projects/` JSONL files
- Serves the dashboard UI on `localhost:3847`
- Has a "share" action per flight card that pushes data to the remote board
- Stores the board GUID locally (e.g. in `~/.claude/trafficcontrol.json` or similar)
- Periodically pushes updates for shared flights

### Remote (Railway deployment)

- Deployed on Railway project `8b8770fa-3e7b-49f4-a2fd-bf672da92ee2`
- Receives flight data via API from local instances
- Stores boards and flights (database or in-memory with persistence)
- Serves the same dashboard UI but in read-only mode
- Board URL: `https://<domain>/b/<board-guid>`
- No process scanning, all data comes from local instances pushing to it

### API (Remote server)

```
POST /api/boards
  -> Creates a new board, returns { guid, pin? }

GET  /api/boards/:guid
  -> Returns board info (requires PIN header if set)

PUT  /api/boards/:guid/pin
  -> Sets or updates the PIN for a board

POST /api/boards/:guid/flights
  -> Pushes a flight (session snapshot) to a board

PUT  /api/boards/:guid/flights/:flightId
  -> Updates an existing flight

DELETE /api/boards/:guid/flights/:flightId
  -> Removes a flight from the board

GET  /api/boards/:guid/flights
  -> Returns all flights for a board (requires PIN header if set)
```

### Auth model

- Board access: GUID + optional PIN (sent as `X-Board-Pin` header)
- Flight push: GUID + a board secret (returned at board creation, stored locally)
- No user accounts, no OAuth, no sessions

## User flow

### First time sharing

1. User clicks "share" on a flight card in the local dashboard
2. Local server checks if a board GUID exists in local config
3. If not, creates a new board on the remote server via `POST /api/boards`
4. Stores the returned GUID and board secret locally
5. Pushes the flight data to the board via `POST /api/boards/:guid/flights`
6. Shows the shareable URL: `https://<domain>/b/<guid>`

### Ongoing sharing

1. Local server periodically pushes updated flight data for shared flights
2. Remote dashboard updates in real-time via WebSocket (same as local)

### Viewing a shared board

1. Someone receives the board URL: `https://<domain>/b/<guid>`
2. Opens it in a browser
3. If no PIN is set, sees the dashboard immediately with all shared flights
4. If a PIN is set, sees a PIN entry screen first
5. Dashboard is read-only, same card layout as local but without the "share" button

### Setting a PIN

1. Board owner clicks a settings button on the local dashboard
2. Enters a PIN code
3. Local server sends `PUT /api/boards/:guid/pin` to the remote server
4. All future visitors must enter the PIN

## Deployment

- Railway project ID: `8b8770fa-3e7b-49f4-a2fd-bf672da92ee2`
- Runtime: Bun
- Database: PostgreSQL (via Railway) or SQLite for simplicity
- The same codebase serves both local and remote modes
- Mode determined by environment variable: `TRAFFICCONTROL_MODE=local|remote`
- Local mode: enables process scanning, share buttons
- Remote mode: enables board/flight API, disables process scanning

## File structure (planned)

```
trafficcontrol/
  server.ts            # Main server (both modes)
  lib/
    scanner.ts         # Local process scanning (local mode only)
    boards.ts          # Board/flight CRUD (remote mode)
    db.ts              # Database connection
  public/
    index.html         # Dashboard UI (both modes)
  docs/
    index.html         # Landing page (GitHub Pages)
```
