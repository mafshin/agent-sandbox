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
        _reconnecting = false;
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
