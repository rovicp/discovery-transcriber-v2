// Deepgram pre-recorded ASR. Streams the small extracted FLAC straight to the API
// (createReadStream — never buffered whole in RAM) and returns diarized, timestamped
// utterances. We ask for nova (best accuracy), speaker diarization, punctuation,
// smart formatting, filler words (verbatim), and utterance segmentation.
const fs = require('fs');

const MODEL = process.env.DEEPGRAM_MODEL || 'nova-2';

// Turn Deepgram's response into our normalized items: one line per utterance,
// speaker labelled S1/S2/…, carrying the utterance's start time (seconds).
function normalize(json) {
  const results = json && json.results;
  const durationSeconds = Math.round((json && json.metadata && json.metadata.duration) || 0);

  // Preferred: utterances (already speaker-grouped segments).
  if (results && Array.isArray(results.utterances) && results.utterances.length) {
    const items = results.utterances
      .map((u) => ({
        t: Math.max(0, Math.round(u.start || 0)),
        speaker: `S${(typeof u.speaker === 'number' ? u.speaker : 0) + 1}`,
        text: (u.transcript || '').trim(),
      }))
      .filter((i) => i.text);
    return { items, durationSeconds };
  }

  // Fallback: group consecutive words by speaker.
  const alt = results && results.channels && results.channels[0]
    && results.channels[0].alternatives && results.channels[0].alternatives[0];
  const words = (alt && alt.words) || [];
  const items = [];
  let cur = null;
  for (const w of words) {
    const spk = `S${(typeof w.speaker === 'number' ? w.speaker : 0) + 1}`;
    const token = w.punctuated_word || w.word || '';
    if (!cur || cur.speaker !== spk) {
      if (cur && cur.text.trim()) items.push(cur);
      cur = { t: Math.max(0, Math.round(w.start || 0)), speaker: spk, text: token };
    } else {
      cur.text += ` ${token}`;
    }
  }
  if (cur && cur.text.trim()) items.push(cur);
  for (const i of items) i.text = i.text.trim();
  return { items, durationSeconds };
}

async function transcribeDeepgram(flacPath, { log = () => {} } = {}) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set.');

  const params = new URLSearchParams({
    model: MODEL,
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
    filler_words: 'true',
    language: process.env.ASR_LANGUAGE || 'en',
  });
  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;

  log('  Uploading audio to Deepgram (streamed)…');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/flac' },
    body: fs.createReadStream(flacPath),
    duplex: 'half', // required by Node/undici when the body is a stream
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Deepgram HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const out = normalize(json);
  log(`  Deepgram returned ${out.items.length} utterance(s) across ${out.durationSeconds}s.`);
  return out;
}

module.exports = { transcribeDeepgram, normalize };
