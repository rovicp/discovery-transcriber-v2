# Discovery Transcriber v2 (ASR)

Paste a Google Drive **folder link** → the app crawls the whole folder (and every
subfolder), finds every audio/video file, creates a **`Video/Audio Transcripts`**
subfolder inside that folder, and writes **one verbatim Google Doc transcript per
file** there.

This is a rebuild of the original Discovery Transcriber. Transcription now comes from
a dedicated **ASR** (Speechmatics or Deepgram) instead of Gemini, which fixes the two
failures of the Gemini-video approach: it **crashed Render's RAM** on >2 GB videos
(the SDK loaded the whole file into memory) and produced **inaccurate, loop-ridden**
transcripts with generic speaker labels.

## Pipeline

1. **Extract audio** — the file is streamed from Drive through `ffmpeg -vn` into a
   small mono FLAC. The original (audio or video, any size) is **never loaded into
   RAM** — a 4.7 GB video becomes a ~50 MB audio track.
2. **ASR** — the FLAC is streamed to Speechmatics/Deepgram → accurate words, precise
   timestamps, and speaker **separation** (`S1/S2/…`). Any length; no chunk-window
   loops.
3. **Gemini visual pass (video only)** — one short clip is sampled at the **last 10 s
   of every 10-minute mark** (plus an opening and closing clip), each described under a
   fixed scene scope and merged in as a `[Scene at H:MM:SS — …]` line. Only one tiny
   clip is on disk at a time, so file size never matters.
4. **Claude naming (verbatim-safe)** — Claude reads the transcript + scene context and
   returns a map of each `S1/S2` label to a real **name** (or a role if never named).
   The map is applied to the **labels only**; the ASR's words are never rewritten.
5. **Google Doc** — rendered in the firm's format (`H:MM:SS - Speaker: text`,
   `[Scene …]`/`[Visual: …]` lines) and saved into the `Video/Audio Transcripts`
   subfolder.

Audio-only files skip step 3.

## Layout

| Path | Purpose |
|------|---------|
| `server.js` | Express server + job runner (setup → crawl → transcribe) |
| `jobs/setup.js` | Create the `Video/Audio Transcripts` subfolder |
| `jobs/crawler.js` | Recursive crawl + robust media detection |
| `jobs/transcriber.js` | Per-file loop + transcript Google Doc formatter |
| `lib/pipeline/` | Orchestrator: extract → ASR → visuals → naming → render |
| `lib/asr/` | Provider-agnostic ASR (`deepgram.js`, `speechmatics.js`) |
| `lib/visual/` | Gemini scene-checkpoint pass (`gemini.js`, checkpoints) |
| `lib/refine/` | Claude client + verbatim-safe speaker naming |
| `lib/transcribe/extract.js` | ffmpeg audio extraction + clip extraction |
| `lib/{auth,drive,docs,retry}.js` | Google OAuth + Drive/Docs helpers |

## Setup

1. **Google OAuth** (Web application client); set `GOOGLE_REDIRECT_URI` to
   `https://<your-app>/auth/callback`.
2. One **ASR key** (`DEEPGRAM_API_KEY` or `SPEECHMATICS_API_KEY`), an
   **`ANTHROPIC_API_KEY`**, and a **`GEMINI_API_KEY`** (only used for video visuals).
3. Copy `.env.example` → `.env`, fill values (leave `GOOGLE_REFRESH_TOKEN` blank).
4. Start the app, open `/auth`, authorize with the Google account that can reach the
   target Drive, paste the returned token into `GOOGLE_REFRESH_TOKEN`.

## Run

```bash
npm install        # ffmpeg must be on PATH (it's in the Docker image)
npm start          # http://localhost:3000
npm run check      # syntax-check every file
npm test           # deterministic logic tests (no network)
```

## Deploy to Render

Push to a **new** GitHub repo → **New → Blueprint** (`render.yaml` = one Docker web
service) → paste the secrets → open the URL, run `/auth` once. No login gate.

## Env vars

ASR: `DEEPGRAM_API_KEY` / `SPEECHMATICS_API_KEY` (+ optional `ASR_PROVIDER`,
`DEEPGRAM_MODEL`, `ASR_LANGUAGE`). Naming: `ANTHROPIC_API_KEY` (+ optional
`CLAUDE_MODEL`). Visuals: `GEMINI_API_KEY`, `GEMINI_MODEL`, `VISUAL_INTERVAL_SECONDS`
(default 600), `VISUAL_CLIP_SECONDS` (default 10). Google:
`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN/REDIRECT_URI`. `PORT`.

## Confidentiality

Paid API keys only. Google credentials stay server-side. Uploaded clips are deleted
from the Gemini Files API after use. **Verify transcripts against the recordings
before relying on them in court** — ASR speaker separation is accurate but name
assignment and scene descriptions are aids, not evidence.
