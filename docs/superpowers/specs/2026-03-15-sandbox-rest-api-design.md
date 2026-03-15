# Sandbox REST API — Design Spec
**Date:** 2026-03-15
**Status:** Approved (rev 2)

---

## Overview

Add a REST API server to the agent-sandbox Docker container that exposes browser control and terminal execution as HTTP endpoints, with Swagger UI documentation. The API wraps the `agent-browser` CLI (already installed in the container) and `child_process` for terminal commands.

**Goals:**
- Allow external agents/tools to control the sandbox browser and terminal via simple HTTP calls
- Replace the need to interact with ttyd (graphical terminal) or noVNC programmatically
- Provide self-documenting Swagger UI at `/sandbox-api/docs`

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
  package-lock.json   # committed — required for npm ci in Dockerfile
```

### Integration points

| Component | Change |
|-----------|--------|
| `config/supervisord.conf` | Add `[program:api-server]` at priority 550, `user=agent` |
| `config/nginx.conf` | Add `location /sandbox-api/` proxying to `127.0.0.1:3001` with `proxy_read_timeout 310s`, placed before the `location /` catch-all |
| `Dockerfile` | `COPY api-server/ /opt/api-server/` + `RUN npm ci --prefix /opt/api-server` |
| `scripts/entrypoint.sh` | Add `API → http://localhost:${PORT}/sandbox-api/docs` to startup banner |

### Base path: `/sandbox-api`

The path `/sandbox-api/` is chosen deliberately over `/api/` to avoid conflicting with code-server's internal API paths, which nginx currently forwards to code-server via the `location /` catch-all. Adding a `location /sandbox-api/` block before `location /` uses nginx's longest-prefix rule to route cleanly without affecting code-server.

### agent-browser daemon mode

`agent-browser` runs in persistent daemon mode: calling `agent-browser connect 9222` once starts a background daemon process that keeps a CDP connection open. All subsequent `agent-browser <subcommand>` calls communicate with that daemon via a local socket (stored in `~/.agent-browser/`). This means:

- One `connect` call on server startup; no per-request CDP reconnect overhead.
- If the daemon crashes, all browser endpoints return HTTP 503. A watchdog loop in `index.js` polls every **5 seconds**, detects the crash, and re-runs `connect 9222` with the same 30-attempt retry logic.

### Startup: CDP readiness retry

On process start, `index.js` attempts `agent-browser connect 9222`. Chromium may not be ready yet (it waits for Xvfb, which starts at priority 100). The startup sequence:

1. Retry `agent-browser connect 9222` every **2 seconds**, up to **30 attempts** (60 s total).
2. Log each failed attempt.
3. If all 30 attempts fail, log a fatal error and exit (supervisord will restart the process).
4. Once connected, set a module-level `ready = true` flag.
5. All browser endpoints check `ready`; if false, they return HTTP 503 `{ "success": false, "error": "browser not ready" }`.

---

## API Endpoints

### Base: `/sandbox-api`

All JSON endpoints respond with `Content-Type: application/json` and use the response envelope:

```json
{ "success": true,  "result": <value> }
{ "success": false, "error": "<message>" }
```

HTTP status codes:
- `200` — success
- `400` — bad/missing input
- `404` — resource not found (jobs)
- `408` — sync exec timeout exceeded
- `409` — conflict (e.g. DELETE on already-completed job)
- `500` — subprocess/internal error
- `503` — browser not ready

---

### Browser endpoints

All browser endpoints spawn `agent-browser <subcommand> --json [args]` via `child_process.execFile`, parse stdout as JSON, and return it in the envelope.

| Method | Path | Request body | Description |
|--------|------|--------------|-------------|
| `POST` | `/sandbox-api/browser/open` | `{ "url": "https://..." }` | Navigate to URL |
| `GET`  | `/sandbox-api/browser/screenshot` | — | Base64-encoded PNG in JSON envelope |
| `POST` | `/sandbox-api/browser/snapshot` | `{ "interactive"?: bool, "compact"?: bool, "depth"?: int }` | Accessibility tree as text |
| `POST` | `/sandbox-api/browser/click` | `{ "selector": "@e1" \| ".css" }` | Click element |
| `POST` | `/sandbox-api/browser/fill` | `{ "selector": "...", "text": "..." }` | Clear + fill input |
| `POST` | `/sandbox-api/browser/type` | `{ "selector": "...", "text": "..." }` | Append-type into input |
| `POST` | `/sandbox-api/browser/press` | `{ "key": "Enter" }` | Press keyboard key |
| `POST` | `/sandbox-api/browser/eval` | `{ "expression": "document.title" }` | Evaluate JS, return result |
| `GET`  | `/sandbox-api/browser/url` | — | `{ "result": "https://..." }` |
| `GET`  | `/sandbox-api/browser/title` | — | `{ "result": "Page Title" }` |
| `POST` | `/sandbox-api/browser/scroll` | `{ "direction": "down\|up\|left\|right", "pixels"?: int, "selector"?: string }` | Scroll page or element |
| `POST` | `/sandbox-api/browser/wait` | see below | Wait for condition |

#### Screenshot response

`GET /sandbox-api/browser/screenshot` returns:

```json
{
  "success": true,
  "result": {
    "data": "<base64-encoded PNG>",
    "mimeType": "image/png"
  }
}
```

The server saves to a temp file, reads it, base64-encodes it, then deletes the temp file.

#### Wait endpoint

`POST /sandbox-api/browser/wait` uses a `type` discriminator to avoid ambiguity:

```json
{ "type": "selector",  "selector": ".my-class" }                         // wait for element to appear
{ "type": "timeout",   "ms": 2000 }                                       // wait N milliseconds
{ "type": "pageload",  "condition": "networkidle" | "domcontentloaded" }  // wait for page load event
```

Only the fields relevant to the specified `type` are required; others are ignored.

---

### Terminal endpoints

#### `POST /sandbox-api/terminal/exec`

```json
{
  "command": "ls -la /workspace",
  "mode": "sync",         // "sync" (default) | "async"
  "timeout": 30000        // ms; sync only; default 30000; max 300000
}
```

**sync response** (`200`):
```json
{ "success": true, "result": { "stdout": "...", "stderr": "...", "exitCode": 0 } }
```

**sync timeout** (`408`):
```json
{ "success": false, "error": "timeout" }
```

**async response** (`200`):
```json
{ "success": true, "result": { "jobId": "550e8400-e29b-41d4-a716-446655440000" } }
```

- Commands run via `child_process.spawn('/bin/bash', ['-c', command])` as the `agent` user.
- Working directory: `/workspace`.
- Sync `timeout` is capped server-side at **300 000 ms** (5 minutes); values above this return HTTP 400 `{ "success": false, "error": "timeout exceeds maximum of 300000ms" }`.
- Job IDs generated with `crypto.randomUUID()`.

---

#### `GET /sandbox-api/terminal/jobs/:id`

Poll a running or completed async job.

```json
{
  "success": true,
  "result": {
    "jobId": "550e8400-...",
    "status": "running",    // "running" | "done" | "killed"
    "stdout": "...",        // buffered output so far
    "stderr": "...",
    "exitCode": null        // null while running, integer when done/killed
  }
}
```

Returns `404` if the job ID is unknown or has been evicted.

---

#### `DELETE /sandbox-api/terminal/jobs/:id`

Sends SIGTERM to the running process.

- Job is still `running`: kills it, returns `200 { "success": true }`.
- Job is already `done` or `killed`: returns `409 { "success": false, "error": "job already completed" }`.
- Job ID not found: returns `404`.

---

### Job eviction

Completed and killed jobs are retained in the in-memory `Map` for **5 minutes** after their end time, then removed by a periodic cleanup timer (runs every 60 s). This bounds memory growth without affecting normal polling workflows.

---

## Swagger / OpenAPI

- **Library:** `swagger-jsdoc` (spec from JSDoc `@swagger` comments) + `swagger-ui-express`
- **UI:** `GET /sandbox-api/docs` — interactive Swagger UI
- **Raw spec:** `GET /sandbox-api/docs.json` — OpenAPI 3.0 JSON
- Every endpoint documents: summary, request body schema with examples, response schemas for success and all error cases.

---

## Error Handling

| Scenario | HTTP | Body |
|----------|------|------|
| Missing required field | 400 | `{ "success": false, "error": "..." }` |
| agent-browser exits non-zero | 500 | `{ "success": false, "error": "<stderr>" }` |
| Sync exec timeout (capped at 300 s) | 408 | `{ "success": false, "error": "timeout" }` |
| Job ID not found / evicted | 404 | `{ "success": false, "error": "job not found" }` |
| DELETE on already-completed job | 409 | `{ "success": false, "error": "job already completed" }` |
| Browser not ready (CDP not connected) | 503 | `{ "success": false, "error": "browser not ready" }` |
| All JSON responses | — | `Content-Type: application/json` always set |

---

## Files Changed / Added

```
api-server/                 NEW — Express API server
  index.js
  routes/browser.js
  routes/terminal.js
  package.json
  package-lock.json         committed — required by npm ci
config/supervisord.conf     ADD api-server block (priority 550, user=agent)
config/nginx.conf           ADD location /sandbox-api/ before location /
Dockerfile                  COPY api-server/ + RUN npm ci --prefix /opt/api-server
scripts/entrypoint.sh       ADD API URL line to startup banner
```

---

## Open Questions / Future Work

- Authentication (bearer token via env var) — deferred
- WebSocket streaming for long-running terminal jobs — deferred
- Screenshot diff / baseline comparison endpoint — deferred
- Merge `GET /url` + `GET /title` into a single `GET /info` endpoint — deferred
