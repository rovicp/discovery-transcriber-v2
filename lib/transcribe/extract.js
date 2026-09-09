// ffmpeg layer: stream the Drive file, extract a small mono 16 kHz FLAC, probe
// duration, slice chunks, and detect silence. The multi-GB original is read
// directly from Google Drive over HTTP (with an OAuth bearer token + range
// requests), so it never lands on the server's disk.
const { spawn } = require('child_process');
const path = require('path');
const { getAuthClient } = require('../auth');

const SAMPLE_RATE = 16000;
const SILENCE_MIN_SECONDS = parseFloat(process.env.SILENCE_MIN_SECONDS || '2.5');
const SILENCE_NOISE_DB = parseInt(process.env.SILENCE_NOISE_DB || '-30', 10);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

async function driveMediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
}

async function authHeader() {
  const client = getAuthClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token (check GOOGLE_REFRESH_TOKEN).');
  return `Authorization: Bearer ${token}\r\n`;
}

// Stream the Drive file through ffmpeg → mono 16 kHz FLAC on local disk (small).
async function extractAudioFromDrive(fileId, workDir) {
  const out = path.join(workDir, 'audio.flac');
  const url = await driveMediaUrl(fileId);
  const header = await authHeader();
  await run('ffmpeg', [
    '-nostdin', '-y',
    '-headers', header,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-i', url,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'flac',
    out,
  ]);
  const durationSeconds = await probeDuration(out);
  return { path: out, durationSeconds };
}

// Extract ONE short, downscaled, audio-less video clip [startSec, startSec+durSec]
// straight from Drive for the Gemini visual pass. `-ss` before `-i` fast-seeks via
// HTTP range, so ffmpeg jumps to the timestamp without reading the whole file; the
// output is only a few MB regardless of the source size. Nothing large touches RAM.
async function extractClip(fileId, startSec, durSec, outPath) {
  const url = await driveMediaUrl(fileId);
  const header = await authHeader();
  await run('ffmpeg', [
    '-nostdin', '-y',
    '-headers', header,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
    '-ss', Math.max(0, startSec).toFixed(3),
    '-i', url,
    '-t', Math.max(1, durSec).toFixed(3),
    '-an',
    '-vf', "scale=-2:'min(480,ih)',fps=2",
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
    '-movflags', '+faststart',
    outPath,
  ]);
  return outPath;
}

async function probeDuration(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
  ]);
  try {
    return parseFloat(JSON.parse(stdout).format.duration) || 0;
  } catch (_) {
    return 0;
  }
}

// Cut [start, end] seconds of the extracted audio into its own small FLAC clip.
async function sliceAudio(srcPath, start, end, outPath) {
  const dur = Math.max(0, end - start);
  await run('ffmpeg', [
    '-nostdin', '-y',
    '-ss', start.toFixed(3),
    '-i', srcPath,
    '-t', dur.toFixed(3),
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'flac',
    outPath,
  ]);
  return outPath;
}

// Return [[silenceStart, silenceEnd], ...] via ffmpeg silencedetect.
async function detectSilences(filePath) {
  let stderr = '';
  try {
    const res = await run('ffmpeg', [
      '-nostdin', '-i', filePath,
      '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
      '-f', 'null', '-',
    ]);
    stderr = res.stderr;
  } catch (e) {
    stderr = e.message || '';
  }
  const silences = [];
  let start = null;
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (line.includes('silence_start:')) {
      const v = parseFloat(line.split('silence_start:')[1].trim().split(/\s+/)[0]);
      if (!Number.isNaN(v)) start = v;
    } else if (line.includes('silence_end:') && start !== null) {
      const v = parseFloat(line.split('silence_end:')[1].trim().split(/\s+/)[0].replace('|', ''));
      if (!Number.isNaN(v)) silences.push([start, v]);
      start = null;
    }
  }
  return silences;
}

module.exports = { extractAudioFromDrive, extractClip, probeDuration, sliceAudio, detectSilences, run };
