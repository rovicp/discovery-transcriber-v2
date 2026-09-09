// Full-file transcription orchestrator (ASR + optional Gemini visuals + Claude naming).
//
// Guarantees:
//   * No media in RAM — only a small extracted FLAC and, for video, one short clip
//     at a time are ever on disk. File size is irrelevant.
//   * Words come from a dedicated ASR (accurate timestamps + diarization); real names
//     are assigned by Claude WITHOUT rewriting the words (verbatim-safe).
//   * Video also gets periodic [Scene …] descriptions from Gemini, merged by time.
const fs = require('fs');
const { extractAudioFromDrive, probeDuration } = require('../transcribe/extract');
const { formatHMS } = require('../transcribe/util');
const { transcribeAudio } = require('../asr');
const { describeVideo } = require('../visual');
const { refineSpeakers } = require('../refine');

async function unlinkQuiet(p) { try { await fs.promises.unlink(p); } catch (_) { /* ignore */ } }

// Merge dialogue + visual items onto one timeline. Stable by time; at an equal second
// a [Scene] line comes just before the dialogue at that moment.
function mergeByTime(dialogue, visuals) {
  const decorated = [...dialogue, ...visuals].map((it, i) => ({ it, i }));
  decorated.sort((a, b) => {
    if (a.it.t !== b.it.t) return a.it.t - b.it.t;
    const av = a.it.kind === 'visual' ? 0 : 1;
    const bv = b.it.kind === 'visual' ? 0 : 1;
    if (av !== bv) return av - bv;
    return a.i - b.i;
  });
  return decorated.map((d) => d.it);
}

// Render merged items into the transcript body string the Doc formatter expects.
function render(items) {
  const lines = [];
  for (const it of items) {
    if (it.kind === 'visual') lines.push(`${formatHMS(it.t)} - ${it.body}`);
    else lines.push(`${formatHMS(it.t)} - ${it.speaker}: ${it.text}`);
  }
  return lines.join('\n') + '\n';
}

async function transcribeMedia(file, workDir, log = () => {}) {
  await fs.promises.mkdir(workDir, { recursive: true });
  const isVideo = (file.mimeType || '').startsWith('video/');

  log('  Extracting audio track (streamed from Drive, no disk buildup)…');
  const { path: audioPath, durationSeconds: probed } = await extractAudioFromDrive(file.id, workDir);

  try {
    const asr = await transcribeAudio(audioPath, { log });
    const durationSeconds = asr.durationSeconds || probed || (await probeDuration(audioPath));

    const dialogue = asr.items.map((i) => ({ t: i.t, kind: 'dialogue', speaker: i.speaker, text: i.text }));

    let visuals = [];
    const flaggedRegions = [];
    if (isVideo) {
      visuals = await describeVideo(file.id, durationSeconds, workDir, log);
      for (const v of visuals) if (/unavailable/i.test(v.body)) flaggedRegions.push([v.t, v.t]);
    }

    const merged = mergeByTime(dialogue, visuals);

    log('  Assigning speaker names from context (Claude)…');
    await refineSpeakers(merged, { fileName: file.name, log });

    const transcript = render(merged);
    return { transcript, durationSeconds, flaggedRegions, chunkCount: visuals.length };
  } finally {
    await unlinkQuiet(audioPath);
  }
}

module.exports = { transcribeMedia, mergeByTime, render };
