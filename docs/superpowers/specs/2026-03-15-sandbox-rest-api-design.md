# Sandbox REST API — Design Spec
**Date:** 2026-03-15
**Status:** Approved

---

## Overview

Add a REST API server to the agent-sandbox Docker container that exposes browser control and terminal execution as HTTP endpoints, with Swagger UI documentation. The API wraps the `agent-browser` CLI (already installed in the container) and `child_process` for terminal commands.

**Goals:**
- Allow external agents/tools to control the sandbox browser and terminal via simple HTTP calls
- Replace the need to interact with ttyd (graphical terminal) or noVNC programmatically
- Provide self-documenting Swagger UI at `/api/docs`

**Non-goals:**
- Authentication (deferred)
- Persistent job storage across restarts
- Streaming responses (async polling is sufficient)

---

## Architecture

### New service: `api-server`

A self-contained Node.js Express app added at `api-server/` in the project root.

```
api-server/
  index.js            # Express entry point, Swagger setup, auto-connect to CDP
  routes/
    browser.js        # Browser control endpoints
    terminal.js       # Terminal exec endpoints + in-memory job store
  package.json        # dependencies: express, swagger-jsdoc, swagger-ui-express
```

### Integration points

| Component | Change |
|-----------|--------|
| `config/supervisord.conf` | Add `[program:api-server]` at priority 550 |
| `config/nginx.conf` | Add `location /api/` proxying to `127.0.0.1:3001` |
| `Dockerfile` | `COPY api-server/ /opt/api-server/` + `npm ci --prefix /opt/api-server` |
| `scripts/entrypoint.sh` | Add `API → http://localhost:${PORT}/api/docs` to banner |

### Startup behaviour

On process start, `index.js` runs `agent-browser connect 9222` to attach to the Chromium instance already managed by supervisord. This is a one-time setup step; all subsequent browser commands reuse the existing daemon connection.

---

## API Endpoints

### Base path: `/api`

All responses use the envelope:
```json
{ "success": true,  "result": <value> }
{ "success": false, "error": "<message>" }
```

HTTP status: `200` on success, `400` for bad input, `500` for subprocess errors.

---

### Browser endpoints — `GET/POST /api/browser/*`

| Method | Path | Request body | Description |
|--------|------|--------------|-------------|
| `POST` | `/api/browser/open` | `{ "url": "https://..." }` | Navigate to URL |
| `GET`  | `/api/browser/screenshot` | — | Returns `image/png` directly |
| `POST` | `/api/browser/snapshot` | `{ "interactive": bool, "compact": bool, "depth": int }` | Accessibility tree (text) |
| `POST` | `/api/browser/click` | `{ "selector": "@e1" \| "css" }` | Click element |
| `POST` | `/api/browser/fill` | `{ "selector": "...", "text": "..." }` | Clear + fill input |
| `POST` | `/api/browser/type` | `{ "selector": "...", "text": "..." }` | Append-type into input |
| `POST` | `/api/browser/press` | `{ "key": "Enter" }` | Press keyboard key |
| `POST` | `/api/browser/eval` | `{ "expression": "document.title" }` | Evaluate JS, returns result |
| `GET`  | `/api/browser/url` | — | Current page URL string |
| `GET`  | `/api/browser/title` | — | Current page title string |
| `POST` | `/api/browser/scroll` | `{ "direction": "down", "pixels": 300 }` | Scroll page |
| `POST` | `/api/browser/wait` | `{ "selector": "...", "ms": 1000, "condition": "load" }` | Wait for element/time/load |

Implementation: each endpoint spawns `agent-browser <cmd> --json [args]` via `child_process.execFile`, parses stdout as JSON, and returns it in the envelope.

---

### Terminal endpoints — `POST /api/terminal/*`

#### `POST /api/terminal/exec`

```json
{
  "command": "ls -la /workspace",
  "mode": "sync",       // "sync" (default) | "async"
  "timeout": 30000      // ms, only applies to sync mode (default: 30000)
}
```

**sync response:**
```json
{ "success": true, "result": { "stdout": "...", "stderr": "...", "exitCode": 0 } }
```

**async response:**
```json
{ "success": true, "result": { "jobId": "abc123" } }
```

#### `GET /api/terminal/jobs/:id`

Poll a running or completed async job.

```json
{
  "success": true,
  "result": {
    "jobId": "abc123",
    "status": "running",   // "running" | "done" | "killed"
    "stdout": "...",       // buffered so far
    "stderr": "...",
    "exitCode": null       // null while running, integer when done
  }
}
```

#### `DELETE /api/terminal/jobs/:id`

Kills the running process (SIGTERM). Returns `{ "success": true }`.

**Implementation details:**
- Commands run via `child_process.spawn('/bin/bash', ['-c', command])` as the `agent` user
- Working directory: `/workspace`
- In-memory `Map<jobId, { process, stdout, stderr, status, exitCode }>` — no persistence
- Job IDs: `crypto.randomUUID()`

---

## Swagger / OpenAPI

- **Library:** `swagger-jsdoc` (spec from JSDoc comments) + `swagger-ui-express`
- **UI:** `GET /api/docs` — interactive Swagger UI
- **Raw spec:** `GET /api/docs.json` — OpenAPI 3.0 JSON
- Every endpoint has: summary, description, request body schema with examples, response schema

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| agent-browser subprocess exits non-zero | `{ success: false, error: stderr }` with HTTP 500 |
| Invalid/missing request fields | `{ success: false, error: "..." }` with HTTP 400 |
| sync exec timeout exceeded | Process killed, `{ success: false, error: "timeout" }` with HTTP 504 |
| Job ID not found | HTTP 404 |
| Chromium not yet ready on startup | Browser endpoints return HTTP 503 until connect succeeds |

---

## Files Changed / Added

```
api-server/               NEW — Express API server
config/supervisord.conf   ADD api-server program block
config/nginx.conf         ADD /api/ proxy location
Dockerfile                COPY + npm ci for api-server
scripts/entrypoint.sh     ADD API URL to startup banner
```

---

## Open Questions / Future Work

- Authentication (bearer token via env var) — deferred
- WebSocket streaming for long-running terminal jobs — deferred
- Screenshot diff / baseline comparison endpoint — deferred
