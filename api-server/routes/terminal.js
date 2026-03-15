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
}, CLEANUP_INTERVAL_MS).unref();

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
