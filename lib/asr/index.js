// Provider-agnostic ASR entry point. Both adapters are built; the active one is
// chosen by ASR_PROVIDER, else by whichever key is present. Returns:
//   { items: [{ t, speaker, text }], durationSeconds }
// where speaker is a generic diarization label (S1/S2/…) — real names are assigned
// later by the Claude refine pass.
const { transcribeDeepgram } = require('./deepgram');
const { transcribeSpeechmatics } = require('./speechmatics');

function pickProvider() {
  const p = (process.env.ASR_PROVIDER || '').toLowerCase();
  if (p === 'deepgram') return 'deepgram';
  if (p === 'speechmatics') return 'speechmatics';
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram';
  if (process.env.SPEECHMATICS_API_KEY) return 'speechmatics';
  throw new Error('No ASR provider configured. Set DEEPGRAM_API_KEY or SPEECHMATICS_API_KEY (optionally ASR_PROVIDER).');
}

async function transcribeAudio(flacPath, { log = () => {} } = {}) {
  const provider = pickProvider();
  log(`  ASR provider: ${provider}`);
  return provider === 'deepgram'
    ? transcribeDeepgram(flacPath, { log })
    : transcribeSpeechmatics(flacPath, { log });
}

module.exports = { transcribeAudio, pickProvider };
