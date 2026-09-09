// Speechmatics batch ASR. Streams the small extracted FLAC as multipart (form-data,
// never buffered whole in RAM), polls the job to completion, then fetches the
// json-v2 transcript. We request enhanced accuracy + speaker diarization; the
// word/punctuation items are grouped into speaker-labelled utterance lines.
const fs = require('fs');

const BASE = 'https://asr.api.speechmatics.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch that retries transient network failures ("fetch failed", resets, timeouts).
// Long jobs poll for many minutes, so a single dropped connection must not abort.
async function fetchRetry(url, opts, { attempts = 6, label = 'request' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(30000, 3000 * (i + 1)));
    }
  }
  throw new Error(`Speechmatics ${label} network error after ${attempts} tries: ${lastErr && lastErr.message}`);
}

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
  const submit = await fetchRetry(`${BASE}/jobs`, { method: 'POST', headers: auth, body: form }, { attempts: 3, label: 'submit' });
  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new Error(`Speechmatics submit HTTP ${submit.status}: ${body.slice(0, 300)}`);
  }
  const { id } = await submit.json();
  if (!id) throw new Error('Speechmatics did not return a job id.');
  log(`  Speechmatics job ${id} submitted; waiting for completion…`);

  // Poll until done (batch jobs typically run in ~0.2–0.5× real time). Transient
  // network errors and non-2xx blips are swallowed — we keep polling until the job
  // is genuinely done/rejected or the deadline passes, so one dropped connection
  // during the long wait can't fail the whole file.
  const deadline = Date.now() + 6 * 60 * 60 * 1000; // 6h safety ceiling
  for (;;) {
    if (Date.now() > deadline) throw new Error('Speechmatics job timed out.');
    await sleep(10000);
    let status;
    try {
      const st = await fetch(`${BASE}/jobs/${id}`, { headers: auth });
      if (!st.ok) continue;
      status = ((await st.json()).job || {}).status;
    } catch (_) {
      continue; // transient network blip — keep polling
    }
    if (status === 'done') break;
    if (status === 'rejected' || status === 'expired' || status === 'deleted') {
      throw new Error(`Speechmatics job ${status}.`);
    }
  }

  const tr = await fetchRetry(`${BASE}/jobs/${id}/transcript?format=json-v2`, { headers: auth }, { attempts: 6, label: 'transcript' });
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
