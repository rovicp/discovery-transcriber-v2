// Transcribe every audio/video file at full length and write one Google Doc per
// file into the "Video/Audio Transcripts" subfolder, in the verbatim format.
const fs = require('fs');
const path = require('path');
const { createDoc, batchUpdate, getDocUrl } = require('../lib/docs');
const { transcribeMedia } = require('../lib/pipeline');
const { TIMESTAMP_RE, isHeaderLine, formatTs } = require('../lib/transcribe/util');

const TMP = process.env.MEDIA_TMP_DIR || './tmp_media';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function transcriber(job, addLog) {
  const media = job.files.filter((f) => f.isMedia);
  if (!media.length) {
    addLog('No audio/video files found in the folder. Nothing to transcribe.');
    return;
  }
  addLog(`Transcribing ${media.length} media file(s)…`);
  if (!job.warnings) job.warnings = [];
  job.progress.total = media.length;
  job.progress.processed = 0;
  job.transcripts = [];

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < media.length; i++) {
    const file = media[i];
    addLog(`Transcribing (${i + 1}/${media.length}): ${file.name} (${file.sizeFormatted || ''})`);
    const workDir = path.join(TMP, `${job.id}_${i}`);

    try {
      const { transcript, durationSeconds, flaggedRegions, chunkCount } =
        await transcribeMedia(file, workDir, addLog);

      const docId = await createTranscriptDoc(file, transcript, durationSeconds, flaggedRegions, job.transcriptsFolderId);
      file.transcriptDocId = docId;
      file.transcriptDocUrl = getDocUrl(docId);
      file.transcriptStatus = 'DONE';
      job.transcripts.push({ name: file.name, url: file.transcriptDocUrl });
      addLog(`  ✓ Transcript created (${chunkCount} chunk(s)${flaggedRegions.length ? `, ${flaggedRegions.length} flagged for review` : ''}).`);
      ok++;
    } catch (err) {
      addLog(`  ⚠ ${file.name}: transcription failed: ${err.message}`);
      job.warnings.push(['TRANSCRIPTION', file.name, err.message]);
      await createFailDoc(file, err.message, job.transcriptsFolderId).catch(() => {});
      file.transcriptStatus = 'FAILED';
      failed++;
    } finally {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      job.progress.processed = ok + failed;
    }

    await sleep(300);
  }

  addLog(`Transcription complete: ${ok} succeeded, ${failed} failed.`);
};

// ── Transcript Google Doc formatter (matches the sample PDF) ─────────────────
function isTimestampLine(line) { return TIMESTAMP_RE.test(line.trim()); }
// A visual observation paragraph: starts with "[Scene" / "[Visual" (no leading
// timecode), or the legacy timestamped form.
function isVisualLine(line) {
  const t = line.trim();
  if (/^\[(scene|visual)\b/i.test(t)) return true;
  return isTimestampLine(t) && /\[(visual|scene)\b/i.test(t);
}
function isSectionHeader(line) {
  const t = line.trim();
  if (!t) return false;
  if (isTimestampLine(t)) return false;
  if (isHeaderLine(t)) return false;
  if (/^[-─=*_]{3,}/.test(t)) return false;
  if (/^\[(scene|visual)\b/i.test(t)) return false;
  // Backstop: a stray bare line that reads like a sentence (long, ends with
  // sentence punctuation, or starts lowercase) is body text, not a title —
  // never bold it. Real section titles are no longer emitted, so this only
  // guards against odd model output.
  if (t.length > 60 || /[.?!,]$/.test(t) || /^[a-z]/.test(t)) return false;
  return true;
}

async function createTranscriptDoc(file, transcript, durationSeconds, flaggedRegions, folderId) {
  const baseName = file.name.replace(/\.[^/.]+$/, '');
  const docId = await createDoc(`[Transcript] ${baseName}`, folderId);

  const requests = [];
  let index = 1;
  const ins = (text) => {
    requests.push({ insertText: { location: { index }, text } });
    const start = index;
    index += text.length;
    return start;
  };
  const style = (s, e, fmt) => applyStyle(requests, s, e, fmt);

  let s = ins(`Verbatim Transcript: ${baseName}\n`);
  style(s, index - 1, { heading: 'HEADING_1' });

  const gray = { red: 0.4, green: 0.4, blue: 0.4 };
  s = ins(`File: ${file.name}\n`); style(s, index - 1, { fontSize: 9, color: gray });
  if (file.path) { s = ins(`Path: ${file.path}\n`); style(s, index - 1, { fontSize: 9, color: gray }); }
  s = ins(`Size: ${file.sizeFormatted || '—'}  |  Type: ${file.mimeType}\n`); style(s, index - 1, { fontSize: 9, color: gray });
  s = ins(`Length: ${durationSeconds > 0 ? formatTs(durationSeconds) : 'not detected'}\n`); style(s, index - 1, { fontSize: 9, color: gray });

  s = ins('CONFIDENTIAL — ATTORNEY-CLIENT PRIVILEGED — WORK PRODUCT\n');
  style(s, index - 1, { bold: true, fontSize: 9 });

  if (flaggedRegions && flaggedRegions.length) {
    s = ins(`⚠ ${flaggedRegions.length} section(s) had audio issues and are marked [Audio issue] below — review those timestamps against the recording.\n`);
    style(s, index - 1, { italic: true, fontSize: 9, color: { red: 0.6, green: 0.3, blue: 0 } });
  }

  ins('─────────────────────────────────────────────────────────────────────\n');

  let headerBlockDone = false;
  for (const rawLine of transcript.split('\n')) {
    const line = rawLine;
    if (!line.trim()) { ins('\n'); continue; }

    if (!headerBlockDone && isHeaderLine(line.trim())) {
      s = ins(line + '\n');
      style(s, index - 1, { fontSize: 10, color: gray });
      continue;
    }
    if (!headerBlockDone && (isTimestampLine(line.trim()) || isVisualLine(line.trim()) || isSectionHeader(line.trim()))) {
      headerBlockDone = true;
      ins('\n');
    }

    // Each entry is its own paragraph followed by a blank line for readability.
    if (isVisualLine(line.trim())) {
      s = ins(line + '\n\n');
      style(s, s + line.length, { italic: true });
      continue;
    }
    if (isTimestampLine(line.trim())) {
      s = ins(line + '\n\n');
      const dashIdx = line.indexOf('-');
      if (dashIdx > 0) style(s, s + dashIdx + 1, { bold: true });
      continue;
    }
    if (isSectionHeader(line.trim())) {
      s = ins(line + '\n\n');
      style(s, s + line.length, { bold: true });
      continue;
    }
    ins(line + '\n\n');
  }

  const CHUNK = 500;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await batchUpdate(docId, requests.slice(i, i + CHUNK));
  }
  return docId;
}

async function createFailDoc(file, errorMsg, folderId) {
  const baseName = file.name.replace(/\.[^/.]+$/, '');
  const docId = await createDoc(`[Transcript] ${baseName}`, folderId);
  const requests = [];
  let index = 1;
  const ins = (text) => { requests.push({ insertText: { location: { index }, text } }); index += text.length; };
  const titleStart = 1;
  ins(`Verbatim Transcript: ${baseName}\n`);
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: titleStart, endIndex: titleStart + `Verbatim Transcript: ${baseName}`.length },
      paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType',
    },
  });
  ins('CONFIDENTIAL — ATTORNEY-CLIENT PRIVILEGED — WORK PRODUCT\n');
  ins('────────────────────────────────────────────────────────────────\n\n');
  ins(`⚠ AUTOMATED TRANSCRIPTION FAILED\n\nFile: ${file.name}\nSize: ${file.sizeFormatted || '—'}\nError: ${errorMsg}\n\n`);
  ins(`Please transcribe manually in Gemini (gemini.google.com): upload the file and prompt for a verbatim transcript formatted "H:MM:SS - Speaker: text" with "[Visual: ...]" description lines.`);
  await batchUpdate(docId, requests);
  file.transcriptDocId = docId;
  file.transcriptDocUrl = getDocUrl(docId);
}

function applyStyle(requests, startIdx, endIdx, style) {
  if (endIdx <= startIdx) return;
  if (style.heading) {
    requests.push({ updateParagraphStyle: { range: { startIndex: startIdx, endIndex: endIdx }, paragraphStyle: { namedStyleType: style.heading }, fields: 'namedStyleType' } });
  }
  const textStyle = {};
  const fields = [];
  if (style.bold === true) { textStyle.bold = true; fields.push('bold'); }
  if (style.italic === true) { textStyle.italic = true; fields.push('italic'); }
  if (style.fontSize) { textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' }; fields.push('fontSize'); }
  if (style.color) { textStyle.foregroundColor = { color: { rgbColor: style.color } }; fields.push('foregroundColor'); }
  if (fields.length) {
    requests.push({ updateTextStyle: { range: { startIndex: startIdx, endIndex: endIdx }, textStyle, fields: fields.join(',') } });
  }
}
