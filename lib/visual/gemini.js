// Self-contained Gemini client for the visual pass. Uploads ONE short clip (a few
// MB), waits until it is ACTIVE, asks for a scene description under a fixed scope,
// then deletes it. Transient errors (503 high-demand, 429) are retried.
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

function buildPrompt(clipSeconds, previous = '') {
  const scope =
    'You are a legal videography assistant describing a short body-cam/discovery video clip ' +
    `(about ${clipSeconds} seconds). Describe ONLY what is visibly on screen, covering: ` +
    'setting (location, indoor/outdoor, lighting/time, conditions); who is present and their ' +
    'positions (counts + roles from appearance ONLY — uniformed officer, handcuffed man, ' +
    'seated woman — never guess names); current activity; notable items/events (vehicles, a ' +
    'visible weapon, contraband, documents, injuries — described, not interpreted); and ' +
    'observable demeanor (visible cues only).\n' +
    'RULES: present tense; observable facts only; state uncertainty honestly ("off-frame", ' +
    '"not legible", "partially obscured") and never invent fine detail (distant text, faces); ' +
    'NO names and NO legal conclusions. Output ONLY the description — no preamble or headings.';

  if (previous && previous.trim()) {
    return (
      scope + '\n\n' +
      'For CONTINUITY, here is the description from the PREVIOUS checkpoint:\n' +
      `"""${previous.trim()}"""\n\n` +
      'Now describe THIS clip as a brief UPDATE relative to that previous checkpoint:\n' +
      '- Lead with what has CHANGED (setting, people, positions, activity, notable items).\n' +
      '- For aspects that are the SAME, say so briefly ("Same setting and the same officers ' +
      'as the previous checkpoint") rather than re-describing them in full.\n' +
      '- If essentially nothing has changed, reply with a single short sentence saying the ' +
      'scene is unchanged from the previous checkpoint.\n' +
      'Keep it to 1–3 sentences.'
    );
  }
  return scope + '\n\nThis is the FIRST checkpoint — give a full 1–3 sentence description.';
}

// Describe one local clip file, optionally as an update relative to the previous
// checkpoint's description. Returns a plain description string.
//
// The clip is sent INLINE (base64) rather than through the Files API. The clips are
// only a few MB (10 s, 480p, 2 fps, no audio), well under the inline request limit,
// and inlining avoids the Files API upload/poll/delete round-trip — which is both
// slower and, as observed, prone to transient 500s ("Failed to convert server
// response to JSON").
async function describeClip(clipPath, clipSeconds, previous = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
  });

  const b64 = (await fs.promises.readFile(clipPath)).toString('base64');

  const resp = await withRetry(() => model.generateContent([
    buildPrompt(clipSeconds, previous),
    { inlineData: { mimeType: 'video/mp4', data: b64 } },
  ]), 'clip describe');

  let text = '';
  try { text = resp.response.text(); } catch (_) { /* fallthrough */ }
  return (text || '').trim();
}

module.exports = { describeClip, buildPrompt };
