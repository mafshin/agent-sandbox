'use strict';

const { Router } = require('express');
const { execFile } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');
const { promises: fsPromises } = require('fs');
const { randomUUID } = require('crypto');
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
          const msg = err.killed
            ? `agent-browser command timed out after ${opts.timeout ?? 30_000}ms`
            : (stderr || stdout || err.message).trim();
          reject(new Error(msg));
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
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success: false, error: 'url must use http or https protocol' });
    }
  } catch {
    return res.status(400).json({ success: false, error: 'url is not a valid URL' });
  }
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
  const tmpPath = join(tmpdir(), `sb-screenshot-${randomUUID()}.png`);
  try {
    await runAgentBrowser(['screenshot', tmpPath]);
    const data = (await fsPromises.readFile(tmpPath)).toString('base64');
    try { await fsPromises.unlink(tmpPath); } catch { /* ignore */ }
    res.json({ success: true, result: { data, mimeType: 'image/png' } });
  } catch (err) {
    try { await fsPromises.unlink(tmpPath); } catch { /* ignore */ }
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
  if (depth !== undefined && depth !== null) {
    if (!Number.isInteger(depth) || depth < 1) {
      return res.status(400).json({ success: false, error: 'depth must be a positive integer' });
    }
    args.push('-d', String(depth));
  }
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
 *               selector:
 *                 type: string
 *                 description: CSS selector of element to scroll (optional)
 *     responses:
 *       200:
 *         description: Scrolled
 *       400:
 *         description: Missing or invalid direction
 */
router.post('/scroll', async (req, res) => {
  const { direction, pixels, selector } = req.body ?? {};
  const validDirections = ['up', 'down', 'left', 'right'];
  if (!direction || !validDirections.includes(direction)) {
    return res.status(400).json({ success: false, error: 'direction must be one of: up, down, left, right' });
  }
  const args = ['scroll', direction];
  if (pixels !== undefined && pixels !== null) {
    if (!Number.isInteger(pixels) || pixels < 1) {
      return res.status(400).json({ success: false, error: 'pixels must be a positive integer' });
    }
    args.push(String(pixels));
  }
  if (selector) args.push(selector);
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
    if (ms > 60_000) {
      return res.status(400).json({ success: false, error: 'ms must not exceed 60000 for type "timeout"' });
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
