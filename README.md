# Remix Studio

A private, local video repurposing workspace. Upload a batch, adjust each video's edit, render variants with FFmpeg, and download individual MP4s or a batch ZIP. Processing runs on your machine; no AI service or API key is required.

## What you can do

- Upload multiple videos together and preview each source.
- Apply shared settings, then customize individual videos.
- Change speed, volume, crop, zoom, aspect ratio, color, sharpening, noise, and frame blending; mirror footage and adjust timing.
- Trim footage, add an opening text hook, burn in an uploaded SRT subtitle file, and replace or mute audio.
- Export in the source aspect ratio or 9:16, 1:1, 4:5, or 16:9, with crop or contain framing, resolution, and frame-rate controls.
- Strip file metadata or set a device metadata profile.
- Generate variants, track render progress, cancel jobs, and download completed videos individually or together.

The browser preview approximates supported visual controls. The downloaded render is authoritative, particularly for timing, audio, subtitles, text, and FFmpeg effects.

Metadata changes and visual edits do not guarantee that TikTok, Instagram, or another platform will classify a video as original, recommend it, or permit monetization. Use your own footage or footage you have permission to repurpose.

## Run locally

Requirements: **Node.js 22.12 or newer**, npm, and **FFmpeg / ffprobe** on your `PATH`. Use an FFmpeg build with `libx264`, AAC encoding, `drawtext`, and the `subtitles` filter.

On macOS with Homebrew:

```sh
brew install node ffmpeg
```

On Debian/Ubuntu, install Node.js 22+ using your preferred method, then:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-dejavu-core
```

Install dependencies and start development servers:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards API requests to the backend on port 8787. Keep both processes running; `Ctrl+C` stops them.

For the production build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:8787**. The backend serves the built frontend and API together.

## Workflow

1. Upload one or more videos. Each file is inspected before it enters the library.
2. Select a video and adjust its settings. Use the batch controls to share a starting look, then refine each edit.
3. Optionally upload replacement audio or an SRT file, add a hook, and choose an export format.
4. Start the batch. Jobs render with bounded concurrency, and their progress and errors appear in the queue.
5. Download successful renders as MP4 files or use the batch ZIP download.

Replacement audio loops when it is shorter than the rendered video and is cut to the video's duration when longer. It keeps its own playback speed; the source audio follows the video's trim and speed while preserving pitch.

Subtitles must be supplied as an existing SRT file, timed to the final exported video; automatic transcription is not included. Time shift moves a selected trim window earlier or later within the source; it has no effect when the whole source is selected. Resolution presets cap the shorter image edge without upscaling native footage. Review the exported video before posting.

## Configuration

Set environment variables when starting the backend. See [.env.example](.env.example) for a template; the app does **not** automatically load that file.

| Variable             | Default     | Purpose                                                              |
| -------------------- | ----------- | -------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1` | Backend listen address.                                              |
| `PORT`               | `8787`      | Backend HTTP port.                                                   |
| `DATA_DIR`           | `data`      | Writable directory for uploads, attachments, manifests, and renders. |
| `MAX_FILE_SIZE_MB`   | `500`       | Maximum size per uploaded file, in MiB; accepts 1–2048.              |
| `MAX_FILES`          | `30`        | Maximum files in one upload; accepts 1–100.                          |
| `RENDER_CONCURRENCY` | `2`         | Simultaneous renders; accepts 1–4.                                   |
| `RETENTION_HOURS`    | `24`        | Retention window for finished jobs and source files; accepts 1–720.  |

For example:

```sh
RENDER_CONCURRENCY=1 RETENTION_HOURS=48 npm start
```

Sources and queue manifests are stored on disk so they survive backend restarts. Automatic cleanup removes expired finished jobs and sources while protecting files referenced by active jobs. Download anything you want to keep before its retention period expires. Large batches need enough disk space for both source and rendered files.

This is a private tool with **no user authentication**. Keep the default loopback binding or run it behind your own authenticated access layer.

## Docker

The image includes Node.js, FFmpeg, and fonts. It runs the production app as a non-root user.

```sh
docker build -t remix-studio .
docker run --rm --name remix-studio \
  -p 127.0.0.1:8787:8787 \
  -v remix-data:/app/data \
  remix-studio
```

Open **http://127.0.0.1:8787**. The named volume keeps uploaded files and manifests across container replacements. The container listens on `0.0.0.0` internally; the published port above is limited to your own computer.

To override settings:

```sh
cp .env.example .env
# Set HOST=0.0.0.0 and DATA_DIR=/app/data in .env for Docker.
docker run --rm --name remix-studio \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  -v remix-data:/app/data \
  remix-studio
```

## Development and checks

```sh
npm run typecheck
npm run build
npm test
```

FFmpeg and ffprobe must be installed for media integration tests. GitHub Actions runs the build and tests on pushes to `main` and on manual dispatch.

The frontend uses React, TypeScript, and Vite. The Express API validates uploads, persists sources and jobs, and runs FFmpeg in a background queue. No browser extension or platform account connection is required.

## Troubleshooting

- **Missing FFmpeg:** confirm `ffmpeg -version` and `ffprobe -version` work in the same shell that starts the app, then restart it.
- **Render failed:** inspect the error shown on the job. Confirm the input is a playable video and any uploaded subtitles use SRT format.
- **Text or subtitles fail:** check your FFmpeg build includes `drawtext` and `subtitles`, and install a system font. The Docker image includes these dependencies.
- **Slow exports:** reduce resolution, frame rate, or render concurrency. Encoding speed depends on clip duration, effects, and available CPU.
- **Uploads rejected:** check the per-file size and batch limits in your configuration.
