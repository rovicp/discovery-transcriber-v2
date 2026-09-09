require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthUrl, getTokensFromCode } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'ui')));

// In-memory job store (single-instance; jobs are ephemeral like the analyzer).
const jobs = {};

// ── Auth (one-time Google authorization → refresh token) ──────────────
app.get('/auth', (req, res) => res.redirect(getAuthUrl()));

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Authorization failed</h2><p>${error}</p><p><a href="/auth">Try again</a></p>`);
  if (!code) return res.send('<h2>No authorization code received.</h2>');
  try {
    const tokens = await getTokensFromCode(code);
    res.send(`
      <html><body style="font-family:Arial;padding:40px;max-width:700px;margin:auto">
      <h2>✅ Authorization successful</h2>
      <p>Add this as <strong>GOOGLE_REFRESH_TOKEN</strong> in Render, then redeploy:</p>
      <textarea style="width:100%;height:80px;font-family:monospace">${tokens.refresh_token || 'NO REFRESH TOKEN — re-authorize'}</textarea>
      </body></html>`);
  } catch (err) {
    res.send(`<h2>❌ Error exchanging code</h2><p>${err.message}</p><p><a href="/auth">Try again</a></p>`);
  }
});

app.get('/auth/status', (req, res) => {
  const hasASR = !!(process.env.DEEPGRAM_API_KEY || process.env.SPEECHMATICS_API_KEY);
  res.json({
    // Google + an ASR key + Claude are required; Gemini is only needed for video visuals.
    ready: !!(process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET && hasASR && process.env.ANTHROPIC_API_KEY),
    checks: {
      ASR_API_KEY: hasASR,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN: !!process.env.GOOGLE_REFRESH_TOKEN,
    },
  });
});

// ── App routes ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Shows exactly which commit is running, so you can confirm a deploy is live.
// Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH automatically.
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({
  commit: process.env.RENDER_GIT_COMMIT || 'local',
  shortCommit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
  branch: process.env.RENDER_GIT_BRANCH || '',
  startedAt: STARTED_AT,
  now: new Date().toISOString(),
}));

app.post('/api/analyze', (req, res) => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(503).json({ error: 'Google not authorized yet. Visit /auth to set GOOGLE_REFRESH_TOKEN.' });
  }
  const { folderUrl } = req.body;
  if (!folderUrl) return res.status(400).json({ error: 'A Google Drive folder link is required.' });

  const jobId = 'job_' + uuidv4().replace(/-/g, '').substring(0, 12);
  jobs[jobId] = {
    id: jobId,
    folderUrl,
    status: 'STARTING',
    phase: 'Initializing…',
    startedAt: new Date().toISOString(),
    log: [],
    progress: { total: 0, processed: 0 },
    outputs: {},
    warnings: [],
    error: null,
  };

  runJob(jobId).catch((err) => {
    jobs[jobId].status = 'ERROR';
    jobs[jobId].error = err.message;
    jobs[jobId].log.push(`[${new Date().toLocaleTimeString()}] FATAL: ${err.message}`);
    console.error(`[${jobId}] FATAL:`, err);
  });

  res.json({ jobId });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Job runner: setup (make subfolder) → crawl → transcribe ──
async function runJob(jobId) {
  const job = jobs[jobId];
  const addLog = (msg) => {
    job.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (job.log.length > 300) job.log = job.log.slice(-300);
    console.log(`[${jobId}] ${msg}`);
  };
  const setPhase = (phase, status = 'RUNNING') => { job.phase = phase; job.status = status; addLog(phase); };

  const { extractFolderId } = require('./lib/drive');
  const setup = require('./jobs/setup');
  const crawler = require('./jobs/crawler');
  const transcriber = require('./jobs/transcriber');

  const folderId = extractFolderId(job.folderUrl);
  if (!folderId) throw new Error('Could not extract a folder ID from that link.');
  job.folderId = folderId;

  setPhase('Opening folder and creating the transcripts subfolder…');
  await setup(job, addLog);

  setPhase('Crawling the entire folder for audio/video files…');
  job.files = await crawler(job, addLog);

  setPhase('Transcribing audio/video (full length)…');
  await transcriber(job, addLog);

  job.outputs.transcriptsFolder = job.transcriptsFolderUrl;
  job.outputs.transcripts = job.transcripts || [];

  setPhase('Complete!', 'COMPLETE');
}

app.listen(PORT, () => {
  console.log(`Discovery Transcriber v2 (ASR) running on port ${PORT}`);
  console.log(`Auth: ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ Google authorized' : '⚠ visit /auth'}`);
});

module.exports = app;
