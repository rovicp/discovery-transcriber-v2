// Gemini visual pass (video only). Samples one short clip at fixed checkpoints —
// an opening clip, the last VISUAL_CLIP_SECONDS of every VISUAL_INTERVAL_SECONDS
// mark, and a closing clip — and turns each into one "[Scene at MM:SS — …]" item.
// Only ONE tiny clip exists on disk at a time, so file size is irrelevant and RAM
// never grows. A clip that fails after retries becomes a visible marker; the job
// keeps going (per-clip isolation).
const fs = require('fs');
const path = require('path');
const { extractClip } = require('../transcribe/extract');
const { describeClip } = require('./gemini');
const { formatHMS } = require('../transcribe/util');

const INTERVAL = parseInt(process.env.VISUAL_INTERVAL_SECONDS || '600', 10); // every 10 min
const CLIP = parseInt(process.env.VISUAL_CLIP_SECONDS || '10', 10);          // 10 s each

// → [{ start, end, label }] on the absolute timeline. `label` is the time shown to
// the reader; `start` is where the clip is cut (and the item is anchored for sort).
function computeCheckpoints(duration, interval = INTERVAL, clip = CLIP) {
  if (!(duration > 0)) return [];
  const cps = [];
  cps.push({ start: 0, end: Math.min(clip, duration), label: 0 }); // opening
  for (let m = interval; m < duration; m += interval) {            // last `clip` s of each mark
    cps.push({ start: Math.max(0, m - clip), end: m, label: m });
  }
  cps.push({ start: Math.max(0, duration - clip), end: duration, label: duration }); // closing

  // De-duplicate near-identical windows (short files, marks landing near the end).
  cps.sort((a, b) => a.start - b.start);
  const out = [];
  for (const cp of cps) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(cp.start - prev.start) < Math.max(1, clip / 2)) continue;
    out.push(cp);
  }
  return out;
}

async function describeVideo(fileId, duration, workDir, log = () => {}) {
  const cps = computeCheckpoints(duration);
  log(`  Visual pass: ${cps.length} scene checkpoint(s) (every ${INTERVAL}s, ${CLIP}s each).`);
  const items = [];
  let previous = ''; // last successful description, for continuity/delta

  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const clipPath = path.join(workDir, `clip_${i}.mp4`);
    const at = formatHMS(cp.label);
    try {
      await extractClip(fileId, cp.start, cp.end - cp.start, clipPath);
      const desc = await describeClip(clipPath, Math.max(1, Math.round(cp.end - cp.start)), previous);
      if (desc) previous = desc;
      items.push({
        t: Math.round(cp.start),
        kind: 'visual',
        body: desc ? `[Scene at ${at} — ${desc}]` : `[Visual: unavailable at ${at} — review the recording]`,
      });
      log(`  Scene checkpoint ${i + 1}/${cps.length} at ${at} described.`);
    } catch (err) {
      items.push({
        t: Math.round(cp.start),
        kind: 'visual',
        body: `[Visual: unavailable at ${at} — review the recording]`,
      });
      log(`  ⚠ Scene checkpoint ${i + 1}/${cps.length} at ${at} failed: ${err.message}`);
    } finally {
      try { await fs.promises.unlink(clipPath); } catch (_) { /* ignore */ }
    }
  }
  return items;
}

module.exports = { computeCheckpoints, describeVideo, INTERVAL, CLIP };
