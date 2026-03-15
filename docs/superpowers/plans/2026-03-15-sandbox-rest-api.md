# Sandbox REST API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node.js Express REST API server to the agent-sandbox container that wraps `agent-browser` and shell execution, served at `/sandbox-api/` with Swagger UI at `/sandbox-api/docs`.

**Architecture:** Self-contained Express app at `api-server/` runs on internal port 3001, managed by supervisord. nginx proxies `/sandbox-api/` to it. Browser endpoints spawn `agent-browser --json` subprocesses. Terminal endpoints use `child_process.spawn` with an in-memory job store for async mode.

**Tech Stack:** Node.js 22, Express 4, swagger-jsdoc, swagger-ui-express — all running inside the existing Debian bookworm container alongside Chromium, nginx, supervisord.

**Spec:** `docs/superpowers/specs/2026-03-15-sandbox-rest-api-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `api-server/package.json` | Create | npm metadata + dependencies |
| `api-server/package-lock.json` | Generate | lockfile for `npm ci` in Dockerfile |
| `api-server/state.js` | Create | Shared `browserReady` flag (avoids circular deps) |
| `api-server/routes/terminal.js` | Create | `/terminal/exec`, `/terminal/jobs/:id` (GET+DELETE) + job store |
| `api-server/routes/browser.js` | Create | All `/browser/*` endpoints + `agent-browser` subprocess wrapper |
| `api-server/index.js` | Create | Express app, Swagger, CDP connect retry, watchdog |
| `config/nginx.conf` | Modify | Add `location /sandbox-api/` before `location /` |
| `config/supervisord.conf` | Modify | Add `[program:api-server]` at priority 550 |
| `Dockerfile` | Modify | `COPY api-server/` + `RUN npm ci --prefix /opt/api-server` |
| `scripts/entrypoint.sh` | Modify | Add API URL line to startup banner |

---

## Chunk 1: Scaffold + Terminal Routes

### Task 1: Create `api-server/package.json` and install dependencies

**Files:**
- Create: `api-server/package.json`
- Generate: `api-server/package-lock.json`

- [ ] **Step 1.1: Create `api-server/package.json`**

```json
{
  "name": "api-server",
  "version": "1.0.0",
  "description": "Sandbox REST API — wraps agent-browser CLI and terminal exec",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "swagger-jsdoc": "^6.2.8",
    "swagger-ui-express": "^5.0.1"
  }
}
```

- [ ] **Step 1.2: Install dependencies to generate lockfile**

Run from the project root:
```bash
cd api-server && npm install && cd ..
```

Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 1.3: Verify lockfile exists**

```bash
ls api-server/package-lock.json
```

Expected: file exists.

- [ ] **Step 1.4: Add `node_modules` to `.gitignore`**

Check if `.gitignore` exists at the root. Add this line if not already present:
```
api-server/node_modules/
```

---

### Task 2: Create shared state module

**Files:**
- Create: `api-server/state.js`

- [ ] **Step 2.1: Create `api-server/state.js`**

```javascript
'use strict';

// Shared browser readiness flag.
// Using a module avoids circular imports between index.js and routes/browser.js.
let _ready = false;

module.exports = {
  isBrowserReady: () => _ready,
  setBrowserReady: (value) => { _ready = value; },
};
```

---

### Task 3: Implement terminal routes

**Files:**
- Create: `api-server/routes/terminal.js`

- [ ] **Step 3.1: Create `api-server/routes/terminal.js`**

```javascript
'use strict';

const { Router } = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const router = Router();

// ── In-memory job store ────────────────────────────────────────────────────
const jobs = new Map();

const EVICTION_AFTER_MS = 5 * 60 * 1000;  // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;    // run every 60 s

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.endTime > EVICTION_AFTER_MS) {
      jobs.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS).unref(); // .unref() so cleanup timer doesn't keep process alive

// ── Constants ──────────────────────────────────────────────────────────────
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const SPAWN_OPTS = {
  cwd: '/workspace',
  env: { ...process.env, HOME: '/home/agent', USER: 'agent', TERM: 'xterm-256color' },
};

// ── POST /terminal/exec ────────────────────────────────────────────────────

/**
 * @swagger
 * /terminal/exec:
 *   post:
 *     summary: Execute a shell command
 *     description: |
 *       Runs a bash command. Use `mode: "sync"` (default) to wait for completion,
 *       or `mode: "async"` to get a jobId and poll `/terminal/jobs/{id}`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [command]
 *             properties:
 *               command:
 *                 type: string
 *                 example: "ls -la /workspace"
 *               mode:
 *                 type: string
 *                 enum: [sync, async]
 *                 default: sync
 *               timeout:
 *                 type: integer
 *                 default: 30000
 *                 maximum: 300000
 *                 description: Timeout in ms (sync mode only). Max 300000.
 *     responses:
 *       200:
 *         description: sync — stdout/stderr/exitCode; async — jobId
 *         content:
 *           application/json:
 *             examples:
 *               sync:
 *                 value: { success: true, result: { stdout: "file1\n", stderr: "", exitCode: 0 } }
 *               async:
 *                 value: { success: true, result: { jobId: "550e8400-..." } }
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             example: { success: false, error: "command is required" }
 *       408:
 *         description: Sync timeout exceeded
 *         content:
 *           application/json:
 *             example: { success: false, error: "timeout" }
 */
router.post('/exec', (req, res) => {
  const { command, mode = 'sync', timeout = DEFAULT_TIMEOUT_MS } = req.body ?? {};

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, error: 'command is required' });
  }
  if (!['sync', 'async'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'mode must be "sync" or "async"' });
  }
  if (mode === 'async') {
    const jobId = randomUUID();
    const child = spawn('/bin/bash', ['-c', command], SPAWN_OPTS);
    const job = {
      jobId,
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      process: child,
    };
    jobs.set(jobId, job);

    child.stdout.on('data', (chunk) => { job.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { job.stderr += chunk.toString(); });
    child.on('close', (code) => {
      // Don't overwrite 'killed' status set by the DELETE handler
      if (job.status !== 'killed') job.status = 'done';
      job.exitCode = code;
      if (job.endTime === null) job.endTime = Date.now();
      job.process = null;
    });

    return res.json({ success: true, result: { jobId } });
  }

  // sync mode — validate timeout here (irrelevant for async)
  if (typeof timeout !== 'number' || timeout <= 0) {
    return res.status(400).json({ success: false, error: 'timeout must be a positive number' });
  }
  if (timeout > MAX_TIMEOUT_MS) {
    return res.status(400).json({ success: false, error: `timeout exceeds maximum of ${MAX_TIMEOUT_MS}ms` });
  }

  const child = spawn('/bin/bash', ['-c', command], SPAWN_OPTS);
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeout);

  child.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) {
      return res.status(408).json({ success: false, error: 'timeout' });
    }
    res.json({ success: true, result: { stdout, stderr, exitCode: code } });
  });
});

// ── GET /terminal/jobs/:id ─────────────────────────────────────────────────

/**
 * @swagger
 * /terminal/jobs/{id}:
 *   get:
 *     summary: Poll an async job
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Job status and buffered output
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               result:
 *                 jobId: "550e8400-..."
 *                 status: "done"
 *                 stdout: "hello\n"
 *                 stderr: ""
 *                 exitCode: 0
 *       404:
 *         description: Job not found or evicted
 */
router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'job not found' });

  const { jobId, status, stdout, stderr, exitCode } = job;
  res.json({ success: true, result: { jobId, status, stdout, stderr, exitCode } });
});

// ── DELETE /terminal/jobs/:id ──────────────────────────────────────────────

/**
 * @swagger
 * /terminal/jobs/{id}:
 *   delete:
 *     summary: Kill a running async job
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job killed
 *       404:
 *         description: Job not found
 *       409:
 *         description: Job already completed
 */
router.delete('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'job not found' });
  if (job.status !== 'running') {
    return res.status(409).json({ success: false, error: 'job already completed' });
  }

  job.process.kill('SIGTERM');
  job.status = 'killed';
  job.endTime = Date.now();
  job.process = null;

  res.json({ success: true });
});

module.exports = router;
```

---

### Task 4: Smoke-test terminal routes in the container

- [ ] **Step 4.1: Copy files into running container and install**

```bash
docker exec agent-sandbox mkdir -p /opt/api-server/routes
docker cp api-server/package.json agent-sandbox:/opt/api-server/package.json
docker cp api-server/package-lock.json agent-sandbox:/opt/api-server/package-lock.json
docker cp api-server/state.js agent-sandbox:/opt/api-server/state.js
docker cp api-server/routes/terminal.js agent-sandbox:/opt/api-server/routes/terminal.js
docker exec agent-sandbox bash -c "cd /opt/api-server && npm ci"
```

Expected: `npm ci` completes, `node_modules/` present.

- [ ] **Step 4.2: Start a minimal test server (terminal only) in the container**

```bash
docker exec -d agent-sandbox bash -c "
node -e \"
const express = require('/opt/api-server/node_modules/express');
const app = express();
app.use(express.json());
app.use('/terminal', require('/opt/api-server/routes/terminal'));
app.listen(3001, '127.0.0.1', () => console.log('test server up'));
\" > /tmp/test-server.log 2>&1
"
sleep 2
```

- [ ] **Step 4.3: Test sync exec**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello","mode":"sync"}'
```

Expected:
```json
{"success":true,"result":{"stdout":"hello\n","stderr":"","exitCode":0}}
```

- [ ] **Step 4.4: Test async exec and polling**

```bash
# Start async job
JOB=$(docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 2 && echo done","mode":"async"}')
echo "$JOB"
JOB_ID=$(echo "$JOB" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

# Poll immediately (should be running)
docker exec agent-sandbox curl -s "http://127.0.0.1:3001/terminal/jobs/$JOB_ID"
sleep 3
# Poll again (should be done)
docker exec agent-sandbox curl -s "http://127.0.0.1:3001/terminal/jobs/$JOB_ID"
```

Expected first poll: `"status":"running"`. Second poll: `"status":"done","stdout":"done\n"`.

- [ ] **Step 4.5: Test validation — missing command**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected: `{"success":false,"error":"command is required"}` with HTTP 400.

- [ ] **Step 4.6: Test timeout cap validation**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hi","timeout":999999}'
```

Expected: `{"success":false,"error":"timeout exceeds maximum of 300000ms"}` with HTTP 400.

- [ ] **Step 4.7: Test DELETE on running job**

```bash
JOB=$(docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 30","mode":"async"}')
JOB_ID=$(echo "$JOB" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

docker exec agent-sandbox curl -s -X DELETE "http://127.0.0.1:3001/terminal/jobs/$JOB_ID"
docker exec agent-sandbox curl -s "http://127.0.0.1:3001/terminal/jobs/$JOB_ID"
```

Expected DELETE: `{"success":true}`. Subsequent GET: `"status":"killed"`.

- [ ] **Step 4.8: Test DELETE on already-completed job (expect 409)**

```bash
# Wait for the job from 4.7 to be polled then verify it's killed, then DELETE again
docker exec agent-sandbox curl -s -X DELETE "http://127.0.0.1:3001/terminal/jobs/$JOB_ID"
```

Expected: `{"success":false,"error":"job already completed"}` with HTTP 409.

- [ ] **Step 4.9: Test sync timeout (expect 408)**

```bash
docker exec agent-sandbox curl -s -w "\nHTTP %{http_code}" -X POST \
  http://127.0.0.1:3001/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 5","mode":"sync","timeout":500}'
```

Expected: `{"success":false,"error":"timeout"}` with HTTP 408 within ~1 second.

- [ ] **Step 4.10: Stop test server**

```bash
docker exec agent-sandbox pkill -f "node /opt/api-server" 2>/dev/null || true
docker exec agent-sandbox pkill -f "node -e" 2>/dev/null || true
```

---

## Chunk 2: Browser Routes + Entry Point

### Task 5: Implement browser routes

**Files:**
- Create: `api-server/routes/browser.js`

- [ ] **Step 5.1: Create `api-server/routes/browser.js`**

```javascript
'use strict';

const { Router } = require('express');
const { execFile } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');
const { readFileSync, unlinkSync } = require('fs');
const { isBrowserReady } = require('../state');

const router = Router();

// ── Middleware: reject if browser not yet connected ────────────────────────
router.use((req, res, next) => {
  if (!isBrowserReady()) {
    return res.status(503).json({ success: false, error: 'browser not ready' });
  }
  next();
});

// ── Helper: run agent-browser with --json flag ─────────────────────────────
// Returns parsed JSON result or throws on non-zero exit.
function runAgentBrowser(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const allArgs = [...args, '--json'];
    execFile(
      'agent-browser',
      allArgs,
      {
        timeout: opts.timeout ?? 30_000,
        env: { ...process.env, HOME: '/home/agent' },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || stdout || err.message).trim()));
          return;
        }
        const raw = stdout.trim();
        try {
          resolve(JSON.parse(raw));
        } catch {
          // agent-browser returned non-JSON (e.g. plain text from snapshot)
          resolve({ output: raw });
        }
      },
    );
  });
}

// ── POST /browser/open ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/open:
 *   post:
 *     summary: Navigate to a URL
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 example: "https://example.com"
 *     responses:
 *       200:
 *         description: Navigation successful
 *       400:
 *         description: Missing url
 *       503:
 *         description: Browser not ready
 */
router.post('/open', async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });
  try {
    const result = await runAgentBrowser(['open', url]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /browser/screenshot ────────────────────────────────────────────────

/**
 * @swagger
 * /browser/screenshot:
 *   get:
 *     summary: Take a screenshot
 *     description: Returns a base64-encoded PNG inside the standard JSON envelope.
 *     responses:
 *       200:
 *         description: Screenshot data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 result:
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: string
 *                       description: Base64-encoded PNG
 *                     mimeType:
 *                       type: string
 *                       example: image/png
 */
router.get('/screenshot', async (req, res) => {
  const tmpPath = join(tmpdir(), `sb-screenshot-${Date.now()}.png`);
  try {
    await runAgentBrowser(['screenshot', tmpPath]);
    const data = readFileSync(tmpPath).toString('base64');
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    res.json({ success: true, result: { data, mimeType: 'image/png' } });
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/snapshot ─────────────────────────────────────────────────

/**
 * @swagger
 * /browser/snapshot:
 *   post:
 *     summary: Get accessibility tree
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               interactive:
 *                 type: boolean
 *                 description: Only interactive elements (-i flag)
 *               compact:
 *                 type: boolean
 *                 description: Compact output (-c flag)
 *               depth:
 *                 type: integer
 *                 description: Limit tree depth
 *     responses:
 *       200:
 *         description: Accessibility tree text
 */
router.post('/snapshot', async (req, res) => {
  const { interactive, compact, depth } = req.body ?? {};
  const args = ['snapshot'];
  if (interactive) args.push('-i');
  if (compact) args.push('-c');
  if (typeof depth === 'number') args.push('-d', String(depth));
  try {
    const result = await runAgentBrowser(args);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/click ────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/click:
 *   post:
 *     summary: Click an element
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [selector]
 *             properties:
 *               selector:
 *                 type: string
 *                 description: "@ref from snapshot (e.g. @e1) or CSS selector"
 *                 example: "@e1"
 *     responses:
 *       200:
 *         description: Click successful
 *       400:
 *         description: Missing selector
 */
router.post('/click', async (req, res) => {
  const { selector } = req.body ?? {};
  if (!selector) return res.status(400).json({ success: false, error: 'selector is required' });
  try {
    const result = await runAgentBrowser(['click', selector]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/fill ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/fill:
 *   post:
 *     summary: Clear and fill an input
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [selector, text]
 *             properties:
 *               selector:
 *                 type: string
 *               text:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fill successful
 *       400:
 *         description: Missing selector or text
 */
router.post('/fill', async (req, res) => {
  const { selector, text } = req.body ?? {};
  if (!selector) return res.status(400).json({ success: false, error: 'selector is required' });
  if (text === undefined) return res.status(400).json({ success: false, error: 'text is required' });
  try {
    const result = await runAgentBrowser(['fill', selector, text]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/type ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/type:
 *   post:
 *     summary: Append-type text into an input
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [selector, text]
 *             properties:
 *               selector:
 *                 type: string
 *               text:
 *                 type: string
 *     responses:
 *       200:
 *         description: Type successful
 */
router.post('/type', async (req, res) => {
  const { selector, text } = req.body ?? {};
  if (!selector) return res.status(400).json({ success: false, error: 'selector is required' });
  if (text === undefined) return res.status(400).json({ success: false, error: 'text is required' });
  try {
    const result = await runAgentBrowser(['type', selector, text]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/press ────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/press:
 *   post:
 *     summary: Press a keyboard key
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key]
 *             properties:
 *               key:
 *                 type: string
 *                 example: "Enter"
 *     responses:
 *       200:
 *         description: Key pressed
 *       400:
 *         description: Missing key
 */
router.post('/press', async (req, res) => {
  const { key } = req.body ?? {};
  if (!key) return res.status(400).json({ success: false, error: 'key is required' });
  try {
    const result = await runAgentBrowser(['press', key]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/eval ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/eval:
 *   post:
 *     summary: Evaluate JavaScript in the browser
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expression]
 *             properties:
 *               expression:
 *                 type: string
 *                 example: "document.title"
 *     responses:
 *       200:
 *         description: JS evaluation result
 *       400:
 *         description: Missing expression
 */
router.post('/eval', async (req, res) => {
  const { expression } = req.body ?? {};
  if (!expression) return res.status(400).json({ success: false, error: 'expression is required' });
  try {
    const result = await runAgentBrowser(['eval', expression]);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /browser/url ───────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/url:
 *   get:
 *     summary: Get current page URL
 *     responses:
 *       200:
 *         description: Current URL string
 *         content:
 *           application/json:
 *             example: { success: true, result: "https://example.com" }
 */
router.get('/url', async (req, res) => {
  try {
    const result = await runAgentBrowser(['get', 'url']);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /browser/title ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/title:
 *   get:
 *     summary: Get current page title
 *     responses:
 *       200:
 *         description: Current page title
 *         content:
 *           application/json:
 *             example: { success: true, result: "Example Domain" }
 */
router.get('/title', async (req, res) => {
  try {
    const result = await runAgentBrowser(['get', 'title']);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/scroll ───────────────────────────────────────────────────

/**
 * @swagger
 * /browser/scroll:
 *   post:
 *     summary: Scroll the page or a specific element
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [direction]
 *             properties:
 *               direction:
 *                 type: string
 *                 enum: [up, down, left, right]
 *               pixels:
 *                 type: integer
 *                 description: Number of pixels to scroll
 *     responses:
 *       200:
 *         description: Scrolled
 *       400:
 *         description: Missing or invalid direction
 */
router.post('/scroll', async (req, res) => {
  const { direction, pixels } = req.body ?? {};
  const validDirections = ['up', 'down', 'left', 'right'];
  if (!direction || !validDirections.includes(direction)) {
    return res.status(400).json({ success: false, error: 'direction must be one of: up, down, left, right' });
  }
  const args = ['scroll', direction];
  if (typeof pixels === 'number') args.push(String(pixels));
  try {
    const result = await runAgentBrowser(args);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /browser/wait ─────────────────────────────────────────────────────

/**
 * @swagger
 * /browser/wait:
 *   post:
 *     summary: Wait for a condition
 *     description: |
 *       `type: "selector"` — wait for element to appear in DOM.
 *       `type: "timeout"` — wait N milliseconds.
 *       `type: "pageload"` — wait for a page load event.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [type, selector]
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [selector]
 *                   selector:
 *                     type: string
 *               - type: object
 *                 required: [type, ms]
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [timeout]
 *                   ms:
 *                     type: integer
 *               - type: object
 *                 required: [type, condition]
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [pageload]
 *                   condition:
 *                     type: string
 *                     enum: [networkidle, domcontentloaded]
 *     responses:
 *       200:
 *         description: Condition met
 *       400:
 *         description: Invalid or missing type/fields
 */
router.post('/wait', async (req, res) => {
  const { type, selector, ms, condition } = req.body ?? {};
  const validTypes = ['selector', 'timeout', 'pageload'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be one of: selector, timeout, pageload' });
  }

  let args;
  let waitTimeoutMs = 30_000;

  if (type === 'selector') {
    if (!selector) return res.status(400).json({ success: false, error: 'selector is required for type "selector"' });
    args = ['wait', selector];
  } else if (type === 'timeout') {
    if (typeof ms !== 'number' || ms <= 0) {
      return res.status(400).json({ success: false, error: 'ms must be a positive number for type "timeout"' });
    }
    args = ['wait', String(ms)];
    // Give agent-browser at least ms + 5s to resolve before we kill the subprocess
    waitTimeoutMs = ms + 5_000;
  } else {
    // pageload
    const validConditions = ['networkidle', 'domcontentloaded'];
    if (!condition || !validConditions.includes(condition)) {
      return res.status(400).json({ success: false, error: 'condition must be "networkidle" or "domcontentloaded"' });
    }
    args = ['wait', '--load', condition];
    waitTimeoutMs = 60_000;
  }

  try {
    const result = await runAgentBrowser(args, { timeout: waitTimeoutMs });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
```

---

### Task 6: Implement `api-server/index.js`

**Files:**
- Create: `api-server/index.js`

- [ ] **Step 6.1: Create `api-server/index.js`**

```javascript
'use strict';

const express = require('express');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { execFile } = require('child_process');
const { setBrowserReady, isBrowserReady } = require('./state');

// Guard flag: prevents a second connectCDP() chain from starting while one is already running.
let _reconnecting = false;

const app = express();
const PORT = 3001;
const BASE = '/sandbox-api';

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());

// ── Swagger ────────────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'agent-sandbox API',
      version: '1.0.0',
      description: 'REST API for controlling the sandbox browser and terminal.\n\n' +
        'Browser endpoints wrap the `agent-browser` CLI. ' +
        'Terminal endpoints execute shell commands as the `agent` user in `/workspace`.',
    },
    servers: [{ url: BASE }],
  },
  apis: [__dirname + '/routes/*.js'],
});

app.use(`${BASE}/docs`, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get(`${BASE}/docs.json`, (req, res) => res.json(swaggerSpec));

// ── Routes ─────────────────────────────────────────────────────────────────
app.use(`${BASE}/browser`, require('./routes/browser'));
app.use(`${BASE}/terminal`, require('./routes/terminal'));

// ── Health ─────────────────────────────────────────────────────────────────
app.get(`${BASE}/health`, (req, res) => {
  res.json({ success: true, result: { browserReady: isBrowserReady() } });
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'not found' });
});

// ── Error handler ──────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api-server] Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// ── CDP connect with retry ─────────────────────────────────────────────────
const MAX_ATTEMPTS = 30;
const RETRY_INTERVAL_MS = 2_000;
const WATCHDOG_INTERVAL_MS = 5_000;

function connectCDP(attempt = 1) {
  _reconnecting = true;
  execFile(
    'agent-browser',
    ['connect', '9222'],
    { env: { ...process.env, HOME: '/home/agent' } },
    (err) => {
      if (!err) {
        console.log('[api-server] Connected to Chromium CDP');
        setBrowserReady(true);
        _reconnecting = false;
      } else if (attempt < MAX_ATTEMPTS) {
        console.log(`[api-server] CDP connect attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying…`);
        setTimeout(() => connectCDP(attempt + 1), RETRY_INTERVAL_MS);
      } else {
        console.error('[api-server] Failed to connect to CDP after 30 attempts — exiting');
        process.exit(1);
      }
    },
  );
}

// ── Watchdog: detect daemon crash and reconnect ────────────────────────────
function startWatchdog() {
  setInterval(() => {
    // Skip if not yet connected or already mid-reconnect
    if (!isBrowserReady() || _reconnecting) return;
    execFile(
      'agent-browser',
      ['get', 'url'],
      { timeout: 5_000, env: { ...process.env, HOME: '/home/agent' } },
      (err) => {
        if (err) {
          console.warn('[api-server] Browser daemon appears down, reconnecting…');
          setBrowserReady(false);
          connectCDP();
        }
      },
    );
  }, WATCHDOG_INTERVAL_MS).unref();
}

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[api-server] Listening on http://127.0.0.1:${PORT}${BASE}`);
  connectCDP();
  startWatchdog();
});
```

---

### Task 7: Smoke-test the full server in the container

- [ ] **Step 7.1: Copy all remaining files**

```bash
docker cp api-server/state.js agent-sandbox:/opt/api-server/state.js
docker cp api-server/routes/browser.js agent-sandbox:/opt/api-server/routes/browser.js
docker cp api-server/index.js agent-sandbox:/opt/api-server/index.js
```

- [ ] **Step 7.2: Start the full server manually**

```bash
docker exec -d agent-sandbox bash -c \
  "HOME=/home/agent node /opt/api-server/index.js > /tmp/api-server.log 2>&1"
sleep 5
docker exec agent-sandbox cat /tmp/api-server.log
```

Expected log: `Connected to Chromium CDP` and `Listening on http://127.0.0.1:3001/sandbox-api`.

- [ ] **Step 7.3: Test health endpoint**

```bash
docker exec agent-sandbox curl -s http://127.0.0.1:3001/sandbox-api/health
```

Expected: `{"success":true,"result":{"browserReady":true}}`

- [ ] **Step 7.4: Verify `agent-browser screenshot <path> --json` is valid**

```bash
docker exec agent-sandbox bash -c \
  "HOME=/home/agent agent-browser screenshot /tmp/verify-shot.png --json && echo OK"
```

Expected: prints `OK` and `/tmp/verify-shot.png` exists. If this fails with "unexpected argument", remove `--json` from the `runAgentBrowser` call in the screenshot handler (the file path is the only thing needed).

- [ ] **Step 7.5: Test browser open + screenshot**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/sandbox-api/browser/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

docker exec agent-sandbox curl -s http://127.0.0.1:3001/sandbox-api/browser/screenshot \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('PNG bytes:', len(d['result']['data']))"
```

Expected: navigation success; PNG base64 with non-zero length.

- [ ] **Step 7.5: Test snapshot**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/sandbox-api/browser/snapshot \
  -H 'Content-Type: application/json' \
  -d '{"interactive":true}'
```

Expected: `{"success":true,"result":{"output":"..."}}` with DOM elements listed.

- [ ] **Step 7.6: Test terminal exec (sync)**

```bash
docker exec agent-sandbox curl -s -X POST http://127.0.0.1:3001/sandbox-api/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"pwd","mode":"sync"}'
```

Expected: `{"success":true,"result":{"stdout":"/workspace\n","stderr":"","exitCode":0}}`

- [ ] **Step 7.7: Stop the manual server**

```bash
docker exec agent-sandbox pkill -f "node /opt/api-server/index.js" 2>/dev/null || true
```

---

## Chunk 3: Integration (nginx, supervisord, Dockerfile, entrypoint)

### Task 8: Update `config/nginx.conf`

**Files:**
- Modify: `config/nginx.conf`

- [ ] **Step 8.1: Add `/sandbox-api/` proxy location before `location /`**

In `config/nginx.conf`, insert the following block **before** the existing `location /` catch-all block (currently at line 73):

```nginx
        # ── sandbox REST API ───────────────────────────────────────────────────
        location /sandbox-api/ {
            proxy_pass         http://127.0.0.1:3001;
            proxy_http_version 1.1;
            proxy_set_header   Host       $host;
            proxy_set_header   X-Real-IP  $remote_addr;
            proxy_read_timeout 310s;
            proxy_send_timeout 310s;
        }
```

The file's `location /` block must remain last. Verify the block order in the file is:
1. `location = /`
2. `location /vnc/`
3. `location /websockify`
4. `location /terminal/`
5. `location /editor/`
6. **`location /sandbox-api/`** ← new
7. `location /` (catch-all)

- [ ] **Step 8.2: Verify nginx config syntax**

```bash
docker cp config/nginx.conf agent-sandbox:/etc/nginx/nginx.conf
docker exec agent-sandbox nginx -t
```

Expected: `syntax is ok` and `test is successful`.

- [ ] **Step 8.3: Reload nginx**

```bash
docker exec agent-sandbox nginx -s reload
```

---

### Task 9: Update `config/supervisord.conf`

**Files:**
- Modify: `config/supervisord.conf`

- [ ] **Step 9.1: Add `[program:api-server]` block at priority 550**

In `config/supervisord.conf`, add the following block **after** the `[program:code-server]` section and **before** the `[program:nginx]` section:

```ini
# ── 8. Sandbox REST API ────────────────────────────────────────────────────
[program:api-server]
command=node /opt/api-server/index.js
user=agent
autostart=true
autorestart=true
priority=550
startsecs=3
startretries=5
stdout_logfile=/var/log/supervisor/api-server.log
stderr_logfile=/var/log/supervisor/api-server.log
environment=HOME="/home/agent",USER="agent",NODE_ENV="production"
```

- [ ] **Step 9.2: Copy and reload supervisord config**

```bash
docker cp config/supervisord.conf agent-sandbox:/etc/supervisor/conf.d/sandbox.conf
docker exec agent-sandbox supervisorctl reread
docker exec agent-sandbox supervisorctl update
sleep 5
docker exec agent-sandbox supervisorctl status
```

Expected: all 8 services RUNNING, including `api-server`.

---

### Task 10: Update `Dockerfile`

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 10.1: Add api-server copy + install after the existing `COPY config/` block**

Find this existing block in the Dockerfile:
```dockerfile
# ── Copy scripts ──────────────────────────────────────────────────────────────
COPY scripts/entrypoint.sh    /entrypoint.sh
```

Insert the following block **before** that `COPY scripts/` block:

```dockerfile
# ── api-server ────────────────────────────────────────────────────────────────
COPY api-server/package.json      /opt/api-server/package.json
COPY api-server/package-lock.json /opt/api-server/package-lock.json
RUN npm ci --prefix /opt/api-server --omit=dev
COPY api-server/state.js          /opt/api-server/state.js
COPY api-server/index.js          /opt/api-server/index.js
COPY api-server/routes/           /opt/api-server/routes/
```

Note: copying `package.json` + `package-lock.json` first and running `npm ci` before copying source files is intentional — it leverages Docker layer caching so `npm ci` is not re-run on every source code change.

---

### Task 11: Update `scripts/entrypoint.sh`

**Files:**
- Modify: `scripts/entrypoint.sh`

- [ ] **Step 11.1: Add API URL to the startup banner**

In `scripts/entrypoint.sh`, find these lines:
```bash
echo "  Terminal   →  http://localhost:${PORT}/terminal/"
echo ""
```

Add the API line between Terminal and the blank line:
```bash
echo "  Terminal   →  http://localhost:${PORT}/terminal/"
echo "  API        →  http://localhost:${PORT}/sandbox-api/docs"
echo ""
```

---

### Task 12: Rebuild image and run end-to-end tests

- [ ] **Step 12.1: Build the Docker image**

From the project root:
```bash
docker build -t agent-sandbox:dev . 2>&1 | tail -20
```

Expected: `Successfully built <id>` and `Successfully tagged agent-sandbox:dev`.

- [ ] **Step 12.2: Stop and replace the running container**

```bash
docker stop agent-sandbox
docker rm agent-sandbox
docker run -d \
  --name agent-sandbox \
  -p 9080:8080 \
  --shm-size=2gb \
  --security-opt seccomp:unconfined \
  agent-sandbox:dev
```

- [ ] **Step 12.3: Wait for services and check health**

```bash
sleep 15
docker exec agent-sandbox supervisorctl status
```

Expected: all 8 services RUNNING (xvfb, chromium, x11vnc, websockify, ttyd, code-server, api-server, nginx).

- [ ] **Step 12.4: End-to-end test — health via nginx**

```bash
curl -s http://localhost:9080/sandbox-api/health
```

Expected: `{"success":true,"result":{"browserReady":true}}`

- [ ] **Step 12.5: End-to-end test — Swagger UI reachable**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:9080/sandbox-api/docs/
```

Expected: `200`

- [ ] **Step 12.6: End-to-end test — Swagger spec contains all routes**

```bash
curl -s http://localhost:9080/sandbox-api/docs.json \
  | python3 -c "import sys,json; s=json.load(sys.stdin); paths=list(s['paths'].keys()); print(len(paths),'paths'); print('\n'.join(sorted(paths)))"
```

Expected: 15 paths listed covering `/browser/open`, `/browser/screenshot`, `/browser/snapshot`, `/browser/click`, `/browser/fill`, `/browser/type`, `/browser/press`, `/browser/eval`, `/browser/url`, `/browser/title`, `/browser/scroll`, `/browser/wait`, `/terminal/exec`, `/terminal/jobs/{id}`.

- [ ] **Step 12.7: End-to-end test — terminal exec**

```bash
curl -s -X POST http://localhost:9080/sandbox-api/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"node --version"}'
```

Expected: `{"success":true,"result":{"stdout":"v22.x.x\n","stderr":"","exitCode":0}}`

- [ ] **Step 12.8: End-to-end test — browser open and screenshot**

```bash
curl -s -X POST http://localhost:9080/sandbox-api/browser/open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

curl -s http://localhost:9080/sandbox-api/browser/screenshot \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('PNG size (bytes):', len(d['result']['data']) * 3 // 4)"
```

Expected: open returns success; screenshot returns PNG with reasonable size (>10000 bytes).

- [ ] **Step 12.9: End-to-end test — agent-browser via terminal exec**

```bash
curl -s -X POST http://localhost:9080/sandbox-api/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"agent-browser --version"}'
```

Expected: `{"success":true,"result":{"stdout":"agent-browser x.x.x\n","stderr":"","exitCode":0}}`

- [ ] **Step 12.10: Commit**

```bash
git add api-server/ config/nginx.conf config/supervisord.conf Dockerfile scripts/entrypoint.sh
git commit -m "feat: add sandbox REST API server at /sandbox-api/

- Express app wrapping agent-browser CLI (browser endpoints)
- Terminal exec with sync/async modes and job store
- Swagger UI at /sandbox-api/docs
- supervisord managed, nginx proxied

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Summary

| Chunk | Tasks | Deliverable |
|-------|-------|-------------|
| 1 | 1–4 | Terminal routes tested in container |
| 2 | 5–7 | Browser routes + full server tested in container |
| 3 | 8–12 | Integrated into image, nginx + supervisord, end-to-end green |
