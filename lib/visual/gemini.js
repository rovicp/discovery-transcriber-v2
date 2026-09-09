// Self-contained Gemini client for the visual pass. Uploads ONE short clip (a few
// MB), waits until it is ACTIVE, asks for a scene description under a fixed scope,
// then deletes it. Transient errors (503 high-demand, 429) are retried.
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetriable(err) {
  if (!err) return false;
  const status = err.status || (err.response && err.response.status);
  if (status === 503 || status === 500 || status === 429) return true;
  const m = (err.message || '').toLowerCase();
  return ['503', '500', '429', 'high demand', 'overloaded', 'unavailable', 'try again',
    'rate limit', 'timeout', 'deadline', 'fetch failed', 'econnreset', 'etimedout',
    'socket hang up', 'network'].some((s) => m.includes(s));
}

const DELAYS = [5000, 15000, 30000, 60000, 90000];
async function withRetry(fn, label = 'Gemini') {
  for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
    try { return await fn(); } catch (err) {
      if (!isRetriable(err) || attempt === DELAYS.length) throw err;
      await sleep(DELAYS[attempt]);
    }
  }
}

function buildPrompt(clipSeconds) {
  return (
    'You are a legal videography assistant describing a short body-cam/discovery video clip ' +
    `(about ${clipSeconds} seconds). Describe ONLY what is visibly on screen, covering, in order:\n` +
    '1. Setting — location type, indoor/outdoor, lighting/time-of-day, conditions.\n' +
    '2. Who is present & their positions — how many people, roles from appearance ONLY ' +
    '(uniformed officer, handcuffed man, seated woman), and spatial relationships. Never guess names.\n' +
    '3. Current activity — what is visibly happening during these seconds.\n' +
    '4. Notable items/events — vehicles, a visible weapon, contraband, documents exchanged, ' +
    'visible injuries — described, not interpreted.\n' +
    '5. Observable demeanor — visible cues only (agitated gestures, crying); no psychological conclusions.\n\n' +
    'RULES: present tense; 1–3 sentences; stage-direction voice; a SELF-CONTAINED snapshot ' +
    '(never "continues to…" or "is still…" — you did not see before or after this clip); ' +
    'state uncertainty honestly ("off-frame", "not legible", "partially obscured") and never ' +
    'invent fine detail (distant text, faces); NO names and NO legal conclusions. ' +
    'Output ONLY the description sentences — no preamble, headings, or timestamps.'
  );
}

// Describe one local clip file. Returns a plain description string.
async function describeClip(clipPath, clipSeconds) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
  });

  const uploaded = await withRetry(
    () => fileManager.uploadFile(clipPath, { mimeType: 'video/mp4', displayName: 'clip' }),
    'clip upload',
  );
  let file = uploaded.file;
  const deadline = Date.now() + 120000;
  try {
    while (file.state === FileState.PROCESSING) {
      if (Date.now() > deadline) throw new Error('Gemini clip processing timed out.');
      await sleep(2000);
      file = await withRetry(() => fileManager.getFile(file.name), 'getFile');
    }
    if (file.state === FileState.FAILED) throw new Error('Gemini failed to process the clip.');

    const resp = await withRetry(() => model.generateContent([
      buildPrompt(clipSeconds),
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    ]), 'clip describe');

    let text = '';
    try { text = resp.response.text(); } catch (_) { /* fallthrough */ }
    return (text || '').trim();
  } finally {
    try { await fileManager.deleteFile(file.name); } catch (_) { /* auto-expires */ }
  }
}

module.exports = { describeClip };
