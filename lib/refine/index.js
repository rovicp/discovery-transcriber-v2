// Claude naming pass — VERBATIM-SAFE and uniqueness-preserving. Claude names a
// diarization label (S1/S2/…) ONLY when the speaker is clearly identified in the audio;
// otherwise the generic label is kept (the legal team fills in names during review).
// Two distinct voices are never merged onto one name. We apply the resulting map to the
// speaker LABELS only — the transcript TEXT is never sent back through the model, so the
// words cannot change.
const { callClaude } = require('./claude');

const MAX_PROMPT_CHARS = parseInt(process.env.REFINE_MAX_CHARS || '180000', 10);

function distinctLabels(items) {
  const seen = [];
  for (const it of items) {
    if (it.kind === 'dialogue' && it.speaker && !seen.includes(it.speaker)) seen.push(it.speaker);
  }
  return seen;
}

// Compact transcript view for context (labels + text; scene lines as [scene] context).
function transcriptView(items) {
  const lines = [];
  for (const it of items) {
    if (it.kind === 'dialogue') lines.push(`${it.speaker}: ${it.text}`);
    else lines.push(`[scene] ${String(it.body || '').replace(/^\[|\]$/g, '')}`);
  }
  let text = lines.join('\n');
  if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS) + '\n…[truncated]';
  return text;
}

function extractJsonObject(s) {
  if (!s) return null;
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

function buildPrompt(labels, view, fileName) {
  return (
    'You are labeling speakers in a verbatim legal transcript (criminal-defense discovery). ' +
    `Each speaker currently has a generic diarization label (${labels.join(', ')}). ` +
    'Scene descriptions appear as [scene] lines for context.\n\n' +
    'TASK: Assign a real NAME to a label ONLY when that speaker is clearly identified in the ' +
    'audio — they state their own name ("my name is Jason Griner") or are directly addressed ' +
    'by name ("thanks, Officer Taylor"). Use that exact name or title.\n\n' +
    'STRICT RULES:\n' +
    '- If you are NOT confident of a specific name for a label, OMIT it (leave it as its ' +
    'generic label). Do NOT guess and do NOT invent a role — a clean generic label is better ' +
    'than a wrong or vague one, because the legal team will fill in names during review.\n' +
    '- Two different labels must NEVER map to the same name — every distinct voice stays distinct.\n' +
    '- Never output "Speaker 1"/"Speaker N" or a bare single letter.\n\n' +
    `File name (context only; never use an id as a person's name): ${fileName}\n\n` +
    'Respond with ONLY a JSON object mapping the labels you are confident about to names, e.g. ' +
    '{"S2":"Jason Griner"}. Omit every label you cannot confidently name. No prose, no code fences.\n\n' +
    'TRANSCRIPT:\n' + view
  );
}

function looksValid(name) {
  if (!name || typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2) return false;
  if (/^speaker\s*\d+$/i.test(t)) return false;
  if (/^s\d+$/i.test(t)) return false;
  return true;
}

// Returns { map, appliedCount }. Mutates items' speaker labels in place.
async function refineSpeakers(items, { fileName = '', log = () => {} } = {}) {
  const labels = distinctLabels(items);
  if (!labels.length) return { map: {}, appliedCount: 0 };

  let map = {};
  try {
    const raw = await callClaude(buildPrompt(labels, transcriptView(items), fileName));
    const parsed = extractJsonObject(raw) || {};
    for (const label of labels) if (looksValid(parsed[label])) map[label] = parsed[label].trim();
  } catch (err) {
    log(`  ⚠ Speaker naming skipped (Claude) — keeping generic labels: ${err.message}`);
    return { map: {}, appliedCount: 0 };
  }

  map = enforceUnique(labels, map); // never collapse two distinct voices onto one name
  const appliedCount = applyMap(items, map);
  const named = Object.entries(map).map(([k, v]) => `${k}→${v}`).join(', ');
  const kept = labels.filter((l) => !map[l]);
  log(`  Speaker names assigned: ${named || '(none)'}${kept.length ? `; kept generic: ${kept.join(', ')}` : ''}.`);
  return { map, appliedCount };
}

// Guarantee the map is injective: if two labels were given the same name, keep it
// only on the first label and drop it from the rest (they revert to their generic
// label). Prevents distinct voices from being merged into one indistinguishable name.
function enforceUnique(labels, map) {
  const usedLower = new Set();
  const out = {};
  for (const label of labels) {
    const v = map[label];
    if (!v) continue;
    const key = v.toLowerCase();
    if (usedLower.has(key)) continue; // duplicate name → leave this label generic
    usedLower.add(key);
    out[label] = v;
  }
  return out;
}

// Apply a label→name map to dialogue items' speaker labels ONLY. Text is never
// touched, so the transcript stays verbatim. Returns how many lines were relabelled.
function applyMap(items, map) {
  let n = 0;
  for (const it of items) {
    if (it.kind === 'dialogue' && map && map[it.speaker]) { it.speaker = map[it.speaker]; n++; }
  }
  return n;
}

module.exports = { refineSpeakers, applyMap, enforceUnique, distinctLabels, transcriptView, extractJsonObject, looksValid };
