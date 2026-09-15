# Remix Studio

A private video repurposing workspace with **Auto remix** selected by default. Import your videos, start the batch, and download fresh edits as MP4s or a ZIP. Editing, speech recognition, and optional language-model planning can all run locally without an API key.

## Auto workflow

1. **Import your videos.** Drop multiple files into the workspace together.
2. **Auto remix all.** Press the Auto remix button to process every uploaded video independently. The default is one vertical 9:16 version, up to 45 seconds, with the original voice.
3. **Review and download.** Follow the editing stages in Exports, preview the finished clips, read what changed, and download individual MP4s or the batch ZIP. Captioned exports also provide downloadable SRT files.

Optional output preferences let you choose **30, 45, or 60 seconds**, **1–5 versions per video**, and **9:16, square, 4:5, 16:9, or original framing**. These durations are upper limits; shorter sources stay short.

With the local speech model ready, Auto transcribes speech, selects a focused excerpt, tightens longer pauses, and prepares an opening hook and timed captions. Automatic framing, gentle motion, and audio balancing finish the cut. Optional Ollama planning helps choose the excerpt and write hooks and callouts from the transcript.

If speech or the speech model is unavailable, Auto falls back to scene and timing edits using the source footage. Captions require a usable transcript. The export notes explain which tools were used and any fallback. Every visual comes from your uploaded footage.

Use your own footage or footage you have permission to repurpose. Review the resulting cut and captions before posting. Editing or changing file metadata does **not** guarantee that TikTok, Instagram, or another platform will classify a video as original, recommend it, or permit monetization.

## Manual editing

Switch to **Manual** for direct control. Its saved settings are separate from Auto edits.

- Upload multiple videos together and preview each source.
- Apply shared settings, then customize individual videos.
- Change speed, volume, crop, zoom, aspect ratio, color, sharpening, noise, and frame blending; mirror footage and adjust timing.
- Trim footage, add an opening text hook, burn in an uploaded SRT subtitle file, and replace or mute audio.
- Export in the source aspect ratio or 9:16, 1:1, 4:5, or 16:9, with framing, resolution, and frame-rate controls.
- Strip file metadata or set a device metadata profile.
- Generate variants, track render progress, cancel jobs, and download completed videos individually or together.

The Manual browser preview approximates supported visual controls. Auto shows the original source until its finished export is ready. Review the rendered export for accurate timing, audio, subtitles, text, and FFmpeg effects.

Replacement audio loops when shorter than the rendered video and is trimmed when longer. It keeps its own playback speed; source audio follows the video's trim and speed while preserving pitch. Uploaded SRT files must be timed to the final exported video.

Time shift moves a selected trim window earlier or later within the source; it has no effect when the whole source is selected. Resolution presets cap the shorter image edge without upscaling native footage. Frame blending has a memory limit, so its smoothing window can shorten on large or high-frame-rate exports.

## Run locally

Requirements: **Node.js 22.12 or newer**, npm, and **FFmpeg / ffprobe** on your `PATH`. Local transcription also needs **Python 3.10–3.13**. Use an FFmpeg build with `libx264`, AAC encoding, `drawtext`, and the libass `subtitles` filter.

On macOS with Homebrew:

```sh
brew install node ffmpeg python@3.12
```

On Debian/Ubuntu, install Node.js 22.12+ using your preferred method, then:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-dejavu-core python3 python3-venv
```

Install dependencies, prepare local transcription, and start development servers:

```sh
npm ci
npm run setup:auto
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards API requests to the backend on port 8787. Keep both processes running; `Ctrl+C` stops them.

`setup:auto` creates an isolated `.venv`, installs [faster-whisper](https://github.com/SYSTRAN/faster-whisper), and downloads the multilingual `small` model into `data/models`. The first setup needs an internet connection; transcription afterward uses cached weights offline. Fresh clones need to run this setup once. Allow roughly 700 MB for the tested environment and model, plus space for videos.

For a smaller speech model:

```sh
npm run setup:auto -- --model tiny
WHISPER_MODEL=tiny npm run dev
```

Smaller models generally trade transcription accuracy for lower resource use. Without this setup, visual Auto edits and Manual mode remain available.

For the production build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:8787**. The backend serves the built frontend and API together.

## Optional local planning and narration

Install and open [Ollama](https://docs.ollama.com/quickstart), then download the configured local planning model:

```sh
ollama pull llama3.2
```

[Llama 3.2](https://ollama.com/library/llama3.2) helps select an excerpt and draft its hook, callouts, and optional narration. The app checks the local Ollama service and can start an installed `ollama` command at the default address. It never downloads a planning model during an export. If planning is unavailable, Auto uses its built-in selection and transcript-derived text.

With local transcription and Ollama ready, **macOS** Auto edits can optionally replace the original voice with a new scripted read using an installed `say` voice. Enable **New narration** in the output preferences when available. A matching voice for the transcript language is required. This uses system voices; it does not clone the original speaker. Linux and Docker retain the original audio because macOS `say` is unavailable.

## Configuration

Set environment variables when starting the backend. See [.env.example](.env.example) for a template; the app does **not** automatically load that file.

| Variable             | Default                  | Purpose                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`              | Backend listen address.                                              |
| `PORT`               | `8787`                   | Backend HTTP port.                                                   |
| `DATA_DIR`           | `data`                   | Writable directory for uploads, attachments, manifests, and renders. |
| `MAX_FILE_SIZE_MB`   | `500`                    | Maximum size per uploaded file, in MiB; accepts 1–2048.              |
| `MAX_FILES`          | `30`                     | Maximum files in one upload; accepts 1–100.                          |
| `RENDER_CONCURRENCY` | `2`                      | Simultaneous renders; accepts 1–4.                                   |
| `RETENTION_HOURS`    | `24`                     | Retention window for finished jobs and source files; accepts 1–720.  |
| `WHISPER_MODEL`      | `small`                  | Local speech model; run setup for the chosen model before use.       |
| `WHISPER_CACHE_DIR`  | `DATA_DIR/models`        | Persistent speech-model cache.                                       |
| `AUTO_LOCAL_AI`      | `true`                   | Set exactly `false` to disable optional Ollama planning.             |
| `OLLAMA_URL`         | `http://127.0.0.1:11434` | Ollama service address; keep local for private processing.           |
| `OLLAMA_MODEL`       | `llama3.2`               | Installed Ollama model used for planning and writing.                |

For example:

```sh
RENDER_CONCURRENCY=1 RETENTION_HOURS=48 npm start
```

Sources and queue manifests are stored on disk so they survive backend restarts. Automatic cleanup removes expired finished jobs and sources while protecting files referenced by active jobs. Download anything you want to keep before its retention period expires. Speech-model weights remain cached. Large batches need enough disk space for both source and rendered files.

This is a private tool with **no user authentication**. Keep the default loopback binding or run it behind your own authenticated access layer.

## Docker

The image includes Node.js, FFmpeg, fonts, Python, and the isolated transcription dependencies. It runs the production app as a non-root user. Models are downloaded into the persistent data volume after the image is built.

```sh
docker build -t remix-studio .
```

Prepare the speech model once for the data volume:

```sh
docker run --rm \
  -v remix-data:/app/data \
  remix-studio npm run setup:auto
```

Then start the app:

```sh
docker run --rm --name remix-studio \
  -p 127.0.0.1:8787:8787 \
  -v remix-data:/app/data \
  remix-studio
```

Open **http://127.0.0.1:8787**. The named volume keeps uploaded files, manifests, and `/app/data/models` across container replacements. The container listens on `0.0.0.0` internally; the published port above is limited to your own computer. Skipping model preparation leaves Auto's visual fallback available.

To override settings:

```sh
cp .env.example .env
# Set HOST=0.0.0.0 and DATA_DIR=/app/data in .env for Docker.
# For a different WHISPER_MODEL, run the setup command with that same env file first.
docker run --rm --name remix-studio \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  -v remix-data:/app/data \
  remix-studio
```

Ollama is optional and is not bundled in this image. For container-based planning, point `OLLAMA_URL` at an Ollama service reachable from the container, with the chosen model already installed. macOS narration is available when running the app directly on macOS, not inside Docker.

## Development and checks

```sh
npm run typecheck
npm run build
npm test
```

FFmpeg and ffprobe must be installed for media integration tests. Local transcription tests use the cached speech model when present; the spoken fixture uses macOS `say`. Tests skip those optional checks when their prerequisites are absent and never download weights. GitHub Actions runs the build and tests on pushes to `main` and on manual dispatch.

The frontend uses React, TypeScript, and Vite. The Express API validates uploads, persists sources and jobs, and runs FFmpeg in a background queue. No browser extension or platform account connection is required.

## Troubleshooting

- **Missing FFmpeg:** confirm `ffmpeg -version` and `ffprobe -version` work in the same shell that starts the app, then restart it.
- **Render failed:** inspect the error shown on the job. Confirm the input is a playable video and any uploaded subtitles use SRT format.
- **Speech editing unavailable:** run `npm run setup:auto` with the same `WHISPER_MODEL` and cache path used to start the app. Allow a few seconds for capability checks to refresh.
- **No Auto captions:** the source may contain no detectable speech. Check the export notes; a visual fallback still produces an edit.
- **Planning unavailable:** confirm Ollama is reachable and `ollama list` includes the configured model. Auto continues with its built-in planning.
- **Narration unavailable:** run directly on macOS with an installed voice for the source language; the export notes describe any narration fallback.
- **Text or subtitles fail:** check your FFmpeg build includes `drawtext` and `subtitles`, and install a system font. The Docker image includes these dependencies.
- **Slow exports:** reduce resolution, frame rate, or render concurrency. Encoding speed depends on clip duration, effects, and available CPU.
- **Uploads rejected:** check the per-file size and batch limits in your configuration.
