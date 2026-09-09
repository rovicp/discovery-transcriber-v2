// Claude naming pass — VERBATIM-SAFE. Claude only decides which real name (or role)
// each diarization label (S1/S2/…) maps to, from context clues in the words and the
// scene descriptions. We then apply that map deterministically to the speaker LABELS.
// The transcript TEXT is never sent back through the model, so the words cannot change.
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
    'You are helping label speakers in a verbatim legal transcript (criminal defense ' +
    'discovery). Below is a diarized transcript where each speaker is a generic label ' +
    `(${labels.join(', ')}). Scene descriptions are shown as [scene] lines for context.\n\n` +
    'TASK: For EACH label, decide the best consistent speaker name using ONLY evidence in ' +
    'the transcript/scenes:\n' +
    '- If a person states or is addressed by name ("my name is Jason Griner", "thanks, ' +
    'Officer Taylor"), use that real name.\n' +
    '- If never named, use a specific ROLE from context (Officer, Detective, Dispatcher, ' +
    'Driver, Passenger, Subject, Interviewer). Prefer a titled role if their function is clear.\n' +
    '- NEVER invent a name that is not supported. NEVER output "Speaker 1"/"Speaker N". ' +
    'NEVER use a bare single letter. Keep one name per label.\n\n' +
    `File name (may hint at a subject, do not use an id as a person's name): ${fileName}\n\n` +
    'Respond with ONLY a JSON object mapping every label to its name, e.g. ' +
    '{"S1":"Officer Taylor","S2":"Jason Griner"} — no prose, no code fences.\n\n' +
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
    log(`  ⚠ Speaker naming skipped (Claude): ${err.message}`);
    return { map: {}, appliedCount: 0 };
  }

  const appliedCount = applyMap(items, map);
  log(`  Speaker names assigned: ${Object.entries(map).map(([k, v]) => `${k}→${v}`).join(', ') || '(none)'}.`);
  return { map, appliedCount };
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

module.exports = { refineSpeakers, applyMap, distinctLabels, transcriptView, extractJsonObject, looksValid };
