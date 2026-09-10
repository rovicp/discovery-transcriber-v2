// Speechmatics batch ASR. Streams the small extracted FLAC as multipart (form-data,
// never buffered whole in RAM), polls the job to completion, then fetches the
// json-v2 transcript. We request enhanced accuracy + speaker diarization; the
// word/punctuation items are grouped into speaker-labelled utterance lines.
const fs = require('fs');
const https = require('https');
const FormData = require('form-data');

const BASE = 'https://asr.api.speechmatics.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Submit a batch job by STREAMING the FLAC from disk (form-data piped over https) —
// the audio is never buffered whole in RAM, so a long file can't spike memory. Uses
// the form-data package (which serializes correctly over Node's http, unlike through
// global fetch). Returns the parsed job JSON.
function submitJob(flacPath, config, authHeaders) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('config', JSON.stringify(config));
    form.append('data_file', fs.createReadStream(flacPath), { filename: 'audio.flac', contentType: 'audio/flac' });

    const req = https.request(`${BASE}/jobs`, {
      method: 'POST',
      headers: { ...authHeaders, ...form.getHeaders() },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Speechmatics submit parse error: ${body.slice(0, 200)}`)); }
        } else {
          reject(new Error(`Speechmatics submit HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    form.on('error', (err) => req.destroy(err));
    form.pipe(req);
  });
}

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

  // Stream the FLAC to Speechmatics (form-data piped over https) — the audio is
  // never buffered whole in RAM, so long files can't spike the instance's memory.
  log('  Uploading audio to Speechmatics (streamed)…');
  let submitted;
  for (let i = 0; i < 3; i++) {
    try { submitted = await submitJob(flacPath, config, auth); break; }
    catch (err) {
      if (i === 2) throw err;
      await sleep(5000 * (i + 1)); // retry transient upload/network failures
    }
  }
  const id = submitted && submitted.id;
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
