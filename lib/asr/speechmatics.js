// Speechmatics batch ASR. Streams the small extracted FLAC as multipart (form-data,
// never buffered whole in RAM), polls the job to completion, then fetches the
// json-v2 transcript. We request enhanced accuracy + speaker diarization; the
// word/punctuation items are grouped into speaker-labelled utterance lines.
const fs = require('fs');

const BASE = 'https://asr.api.speechmatics.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// json-v2 → normalized items (one line per speaker turn, carrying its start time).
function normalize(json) {
  const results = (json && json.results) || [];
  const items = [];
  let cur = null;
  for (const r of results) {
    const alt = (r.alternatives && r.alternatives[0]) || {};
    const content = alt.content || '';
    if (!content) continue;
    const spkRaw = alt.speaker && alt.speaker !== 'UU' ? alt.speaker : 'S1';
    const speaker = /^S\d+$/.test(spkRaw) ? spkRaw : `S${String(spkRaw).replace(/\D/g, '') || '1'}`;

    if (r.type === 'punctuation') {
      if (cur) cur.text += content; // attach with no leading space
      continue;
    }
    if (!cur || cur.speaker !== speaker) {
      if (cur && cur.text.trim()) items.push(cur);
      cur = { t: Math.max(0, Math.round(r.start_time || 0)), speaker, text: content };
    } else {
      cur.text += ` ${content}`;
    }
  }
  if (cur && cur.text.trim()) items.push(cur);
  for (const i of items) i.text = i.text.trim();

  const last = results[results.length - 1];
  const durationSeconds = Math.round((last && last.end_time) || 0);
  return { items, durationSeconds };
}

async function transcribeSpeechmatics(flacPath, { log = () => {} } = {}) {
  const key = process.env.SPEECHMATICS_API_KEY;
  if (!key) throw new Error('SPEECHMATICS_API_KEY is not set.');
  const auth = { Authorization: `Bearer ${key}` };

  const config = {
    type: 'transcription',
    transcription_config: {
      language: process.env.ASR_LANGUAGE || 'en',
      diarization: 'speaker',
      operating_point: 'enhanced',
    },
  };

  // Build a spec-compliant multipart body with the NATIVE (undici) FormData + Blob.
  // The extracted FLAC is small (tens of MB) — this is the derived audio track, not
  // the multi-GB source video — so reading it here is safe. (The `form-data` npm
  // package does not serialize correctly through global fetch: it produced
  // "multipart: NextPart: EOF" on the server.)
  const audioBuf = await fs.promises.readFile(flacPath);
  const form = new FormData();
  form.append('config', JSON.stringify(config));
  form.append('data_file', new Blob([audioBuf]), 'audio.flac');

  log('  Uploading audio to Speechmatics…');
  const submit = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new Error(`Speechmatics submit HTTP ${submit.status}: ${body.slice(0, 300)}`);
  }
  const { id } = await submit.json();
  if (!id) throw new Error('Speechmatics did not return a job id.');
  log(`  Speechmatics job ${id} submitted; waiting for completion…`);

  // Poll until done (batch jobs typically run in ~0.2–0.5× real time).
  const deadline = Date.now() + 6 * 60 * 60 * 1000; // 6h safety ceiling
  for (;;) {
    if (Date.now() > deadline) throw new Error('Speechmatics job timed out.');
    await sleep(10000);
    const st = await fetch(`${BASE}/jobs/${id}`, { headers: auth });
    if (!st.ok) continue; // transient — keep polling
    const status = ((await st.json()).job || {}).status;
    if (status === 'done') break;
    if (status === 'rejected' || status === 'expired' || status === 'deleted') {
      throw new Error(`Speechmatics job ${status}.`);
    }
  }

  const tr = await fetch(`${BASE}/jobs/${id}/transcript?format=json-v2`, { headers: auth });
  if (!tr.ok) {
    const body = await tr.text().catch(() => '');
    throw new Error(`Speechmatics transcript HTTP ${tr.status}: ${body.slice(0, 300)}`);
  }
  const json = await tr.json();
  const out = normalize(json);
  log(`  Speechmatics returned ${out.items.length} turn(s) across ${out.durationSeconds}s.`);
  return out;
}

module.exports = { transcribeSpeechmatics, normalize };
