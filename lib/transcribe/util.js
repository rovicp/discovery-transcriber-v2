// Shared parsing/formatting helpers for transcript lines.

// Matches a leading timestamp: M:SS, MM:SS, or H:MM:SS followed by " - ".
// Seconds/minutes allow 1–2 digits so malformed model stamps like "1:20:0" still
// parse (and then get pinned in-range) instead of leaking in as a fake header.
const TIMESTAMP_RE = /^(\d{1,2}:\d{1,2}(?::\d{1,2})?)\s*-\s*(.*)$/;

// Header-block metadata keys Gemini may emit at the top of a transcript.
const HEADER_KEYS = [
  'case number', 'officer identification', 'officer/subject identification',
  'subject identification', 'date of incident', 'incident date',
  'total video duration', 'total duration', 'recording date', 'badge',
];

function parseTsToSeconds(ts) {
  const parts = ts.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// MM:SS under an hour (matching the sample), H:MM:SS at or beyond an hour.
function formatTs(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function isHeaderLine(line) {
  const lower = line.toLowerCase();
  return HEADER_KEYS.some((k) => lower.startsWith(k + ':'));
}

function isDivider(line) {
  return /^[-─=*_]{3,}\s*$/.test(line.trim());
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').toLowerCase().trim();
}

// Strip a leading literal format-template placeholder the model sometimes echoes
// from the prompt (e.g. "H:MM:SS - ", "HH:MM:SS - ", "MM:SS - ") at the start of a
// line's text. Uses the LITERAL letters H/M/S, so it never touches real times.
function stripTimePlaceholder(s) {
  return (s || '').replace(/^\s*(?:H{1,2}:)?M{1,2}:S{1,2}\s*[-–—]?\s*/i, '').replace(/^\s+/, '');
}

module.exports = {
  TIMESTAMP_RE, HEADER_KEYS, stripTimePlaceholder,
  parseTsToSeconds, formatTs, formatHMS, isHeaderLine, isDivider, normalize,
};
