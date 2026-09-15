# Remix Studio

A private video repurposing workspace with **Auto remix** selected by default. Import your videos, start the batch, and download fresh edits as MP4s or a ZIP. Editing, speech recognition, and optional language-model planning can all run locally without an API key.

## Import long recordings

- **Browse or drop videos:** source imports accept up to **50 GiB per file** by default, including 10–40 GB recordings. Each file transfers in 8 MiB chunks with confirmed progress. Pause an upload, or select the same unchanged file after reloading to resume it. Imports continue while you open Exports or History; keep the browser tab open during transfer.
- **Link files on this computer:** paste one absolute video path per line. On Mac, select files in Finder and press **Option + Command + C** to copy their paths. The app reads the originals through managed links, without copying a 40 GB file. Removing or expiring an import removes the link, leaving the original intact. Keep originals at the same path and unchanged until exports finish. In Docker, the paths must be visible inside the container.
- **Preparation runs in the background:** video metadata, a preview image, and a streaming content fingerprint are prepared with visible progress. Two videos can be analyzed at once. The fingerprint reads the full file to recognize earlier exports, so large originals still take time to prepare.
- Interrupted uploads and pending analysis survive backend restarts. Unused import sessions expire after 48 hours. Source/export retention starts when the source is ready and follows `RETENTION_HOURS`. Available disk space is checked against unfinished uploads; copied sources and exports still need local storage.

Imports support MP4, MOV, M4V, WebM, MKV, AVI, and MPEG, up to 24 hours long. Browser playback depends on the video codec; FFmpeg supports more formats than browsers. The separate B-roll/legacy multipart limit remains `MAX_FILE_SIZE_MB` (500 MiB by default).

## Auto workflow

1. **Import your videos.** Drop multiple files into the workspace together.
2. **Auto remix all.** Press the Auto remix button to process every uploaded video independently. The default is one vertical 9:16 version, up to 45 seconds, with the original voice.
3. **Review and download.** Follow the editing stages in Exports, preview the finished clips, read what changed, and download individual MP4s or the batch ZIP. Captioned exports also provide downloadable SRT files.

Optional output preferences let you choose **30, 45, or 60 seconds**, **1–5 versions per video**, and **9:16, square, 4:5, 16:9, or original framing**. These durations are upper limits; shorter sources stay short.

Select a source video to change **only that video's Auto settings**, including format, duration, narration, supporting visuals, selected B-roll clips, and maximum versions. **Apply to all** copies the selected video's complete settings to the other sources and updates the defaults for future imports. One Auto remix click still processes the whole batch, with each video using its own saved settings. Manual settings remain separate.

The version count is a **maximum**. Auto skips an extra version when it would repeat an already completed edit from the same batch. Short sources normally produce one worthwhile cut; a different headline or color treatment does not make an extra version necessary. Skipped jobs explain the reason and do not create duplicate downloads.

With the local speech model ready, Auto transcribes speech, selects a focused excerpt, tightens longer pauses, and prepares an opening hook and timed captions. Automatic framing and audio balancing finish the cut. Optional Ollama planning helps choose the excerpt and write hooks and callouts from the transcript. Callouts are shown when their words match the edited speech; unmatched ideas are omitted. Auto preserves the source's color and does not add arbitrary noise, speed changes, or mirroring.

If speech or the speech model is unavailable, Auto falls back to scene and timing edits using the source footage. Captions require a usable transcript. The export notes explain which tools were used and any fallback.

Use your own footage or footage you have permission to repurpose. Review the resulting cut and captions before posting. Editing or changing file metadata does **not** guarantee that TikTok, Instagram, or another platform will classify a video as original, recommend it, or permit monetization.

## Optional B-roll and animated cards

Use **Output preferences → Supporting visuals** in Auto mode:

- **Off** keeps the edit focused on the source footage.
- **Stock B-roll · Pixabay** finds existing moving videos from a free stock library, with no uploads required. Choose any stock video (the default) or animation-only results. Add `PIXABAY_API_KEY` to the backend environment to enable search; get a free key from the [Pixabay API page](https://pixabay.com/api/docs/). With local matching, keywords from up to three moments in the edited speech are sent to Pixabay; silent videos use their descriptive filename. AI matching uses DeepSeek to turn spoken ideas and neighboring context into concrete English visual searches, then checks the visible relevance of a small shortlist. All downloaded stock is checked locally for sustained motion in the output crop. No B-roll videos are generated.
- **My B-roll** inserts short supporting shots from a reusable library. Upload your own or licensed video clips once and select the clips available for each source. The default local matching uses filenames/tags and the actual spoken phrases; silent sources can match their descriptive source filename. Optional AI visual matching is described below. The original edit's audio keeps playing underneath.
- **Animated cards** uses [HyperFrames](https://github.com/heygen-com/hyperframes/) locally to turn short phrases from the speech into animated text cards. These are authored graphics, not generated photographic footage. Captions remain above the supporting visuals.
- **Both** allows either type where relevant. Supporting visuals are limited to a few short moments; unmatched clips and unsuitable card placements are skipped.

No HyperFrames or Remotion API key is required for this local implementation. HyperFrames supplies the graphic renderer; the B-roll library supplies actual footage. No paid stock search, cloud rendering, or generative-video service is called. HyperFrames's hosted MCP is a separate HeyGen service requiring account authorization and credits.

`npm ci` installs the pinned HyperFrames renderer and its Chromium browser. If browser installation was skipped, run `npm run setup:visuals` once. Alternatively set `PRODUCER_HEADLESS_SHELL_PATH` to an installed Chromium executable. Generated cards use local fonts and run without external network requests. The app reports a fallback if a requested card cannot be rendered.

Uploaded B-roll clips persist until you remove them from the library; the ordinary source/export retention timer does not delete them. The library holds up to 100 clips and uses `MAX_FILE_SIZE_MB` for its per-file upload limit. Remove unused library clips to reclaim disk space. Clips referenced by active jobs cannot be removed until those jobs finish or are cancelled.

Stock B-roll is **off by default**, as are all supporting visuals. When enabled, the edit uses at most three cutaways, each at most 3.6 seconds, with no more than 30% of the short covered. Main audio and captions continue. A missing key, unavailable service, or lack of a relevant match keeps the original picture. The app makes at most three stock searches per export, with up to three downloads for local matching or six for AI matching; search responses are cached for 24 hours. Downloads are capped at 40 MiB per clip (or the configured upload limit if smaller) and retained with the saved edit plan until its export expires. Stock credits link to each creator's source page in Exports and are included in the batch ZIP's `export-settings.json`.

### Optional AI B-roll matching

Choose **AI visual matching** when the local server has `DEEPSEEK_API_KEY` configured. This uses [DeepSeek Flash's image understanding](https://api-docs.deepseek.com/guides/vision/) to match the visible content of your B-roll to the edited speech. The default model ID is `deepseek-flash`; `DEEPSEEK_MODEL` can override it with a compatible vision model.

1. For stock, prepare up to three semantic search briefs in one bounded text request. Compare up to two candidates per search. Inspect up to five short windows locally for actual motion, reject static/black footage, and prefer footage that fits the output aspect ratio. The vision model sees three frames from the selected output crop. Uploaded library clips retain their short midpoint inspection, up to 20 clips per edit.
2. Ask the vision model what is visible and cache the descriptions locally. Stock descriptions are reused across jobs using provider identity, the downloaded content hash, interval, crop and model. Semantic briefs are cached by transcript context and text model. Set `DEEPSEEK_TEXT_MODEL` to override the text model independently.
3. Match transcript phrases to those descriptions by meaning. For example, "take a break outdoors" can match footage of a person walking in a park even if its filename is `IMG_4821.mp4`.
4. Insert only suitable matches, using the inspected window at the corresponding point in the final speech. Recheck motion in the exact final stock interval after trimming. Cutaways last at most 3.6 seconds, with spacing and total screen-time limits. The main narration continues; captions stay visible. Export notes explain why each AI-selected shot was used.

AI matching is optional and makes paid requests to DeepSeek. It sends sampled **B-roll frames** and **transcript excerpts** to that service; source audio and full video files are not uploaded. Rendering, transcription, and animated cards remain local. Without a usable transcript or a suitable match, or when the API is unavailable, the original picture is kept. An AI rejection never forces a weaker keyword match.

Set the key in your private `.env` file in the project root, then restart the app. Both development and production load it automatically. Keep it out of frontend variables and Git:

```sh
npm run build
npm start
```

`npm run dev` and `npm start` load `.env` automatically. Explicit shell variables take precedence. An ordinary DeepSeek API key is required; a coding subscription is not used. Costs depend on sampled images and tokens, with current rates on [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing/). The app limits requests and reuses inspections to reduce cost. Model output is a relevance suggestion, not a guarantee of editorial quality or platform acceptance.

## Correct an Auto result

New Auto exports save a versioned edit plan. Choose **Edit this result** to change
the opening hook, correct or add timed captions, adjust source cut boundaries,
or disable/replace a supporting shot from the saved choices. B-roll is locked
initially; unlock a shot to change its footage or timing. Each shot has a moving
preview of its selected interval and keeps its source credits.

**Render this revision** creates one corrected export and preserves the previous
version. It reuses saved narration and footage without calling the planners or
stock provider again. Source-cut changes retime retained captions and supporting
shots; clipped phrases are dropped for review. Narrated edits keep their audio
duration. Make cut changes separately from caption/shot timing corrections.

Auto can render the current video, checked videos, or all videos. Saved plans and
their media snapshots follow the export retention period; keep the source video
available to make further revisions. Older exports created before this feature
need a new Auto edit to gain a saved plan.

## Manual editing

Switch to **Manual** for direct control. Its saved settings are separate from Auto edits.

- Upload multiple videos together and preview each source.
- Apply shared settings, then customize individual videos.
- Open **All controls** for the complete adjustment surface, or use the focused Essentials, Color & feel, and Advanced tabs.
- Choose from eight color looks. Looks change color and texture while preserving framing, timing, sound and text. Saved editing presets apply the wider edit settings.
- Type exact slider values and press Enter or leave the field to apply them. Values stay within the supported range; each control has its own reset. Global reset also clears optional framing, motion, caption-style and audio-normalization settings.
- Change speed, volume, crop, zoom, aspect ratio, color, sharpening, noise, and frame blending; mirror footage and adjust timing.
- Position the subject inside cropped or zoomed footage, add a gentle push-in, normalize loudness, and adjust the size and placement of uploaded captions.
- Trim footage, add an opening text hook, burn in an uploaded SRT subtitle file, and replace or mute audio.
- Export in the source aspect ratio or 9:16, 1:1, 4:5, or 16:9, with framing, resolution, and frame-rate controls.
- Strip file metadata for privacy. Device impersonation has been removed; legacy device-profile settings are ignored.
- Generate variants, track render progress, cancel jobs, and download completed videos individually or together.

The **Live** preview follows the effective trim and time shift, and approximates framing and basic color. **Render 5s preview** renders the first five edited seconds through FFmpeg, including image effects, camera movement, uploaded captions, hooks and audio. Samples use up to 720p/60 fps and do not create export/history entries. Full exports remain the final check, especially for effects or audio balancing influenced by resolution or content outside the short sample.

Changing settings hides an outdated sample and cancels a preview still in progress. Only one preview renders at a time; requests time out after 60 seconds. Up to 12 samples are cached locally for 30 minutes, and restart discards the cache. Auto shows the original source until its finished export is ready.

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

Put your settings and API keys in a private `.env` file in the project root. The backend loads it automatically with `npm run dev` and `npm start`; explicit shell variables take precedence. `.env` is ignored by Git. See [.env.example](.env.example) for the available settings.

| Variable             | Default                  | Purpose                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`              | Backend listen address.                                              |
| `PORT`               | `8787`                   | Backend HTTP port.                                                   |
| `DATA_DIR`           | `data`                   | Writable directory for uploads, attachments, manifests, and renders. |
| `MAX_FILE_SIZE_MB`   | `500`                    | B-roll and legacy multipart limit in MiB; accepts 1–2048.           |
| `MAX_LARGE_FILE_SIZE_GB` | `50`                 | Resumable and linked source import limit in GiB; accepts 1–1024.     |
| `MAX_FILES`          | `30`                     | Maximum files in one upload; accepts 1–100.                          |
| `RENDER_CONCURRENCY` | `2`                      | Simultaneous renders; accepts 1–4.                                   |
| `RETENTION_HOURS`    | `24`                     | Retention window for finished jobs and source files; accepts 1–720.  |
| `WHISPER_MODEL`      | `small`                  | Local speech model; run setup for the chosen model before use.       |
| `WHISPER_CACHE_DIR`  | `DATA_DIR/models`        | Persistent speech-model cache.                                       |
| `AUTO_LOCAL_AI`      | `true`                   | Set exactly `false` to disable optional Ollama planning.             |
| `OLLAMA_URL`         | `http://127.0.0.1:11434` | Ollama service address; keep local for private processing.           |
| `OLLAMA_MODEL`       | `llama3.2`               | Installed Ollama model used for planning and writing.                |
| `PIXABAY_API_KEY`    | Unset                    | Optional free stock video search; only used for Stock B-roll.        |

For example:

```sh
RENDER_CONCURRENCY=1 RETENTION_HOURS=48 npm start
```

Sources and queue manifests are stored on disk so they survive backend restarts. Automatic cleanup removes expired finished jobs and sources while protecting files referenced by active jobs. Download anything you want to keep before its retention period expires. Speech-model weights remain cached. Large batches need enough disk space for both source and rendered files.

This is a private tool with **no user authentication**. Keep the default loopback binding or run it behind your own authenticated access layer.

## Docker

The image includes Node.js, FFmpeg, Chromium for HyperFrames cards, fonts, Python, and the isolated transcription dependencies. It runs the production app as a non-root user. Models are downloaded into the persistent data volume after the image is built.

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

### Export history

History records completed exports independently of temporary video files: source
content fingerprint, original source excerpts, saved title, B-roll IDs and intervals,
and publication notes. Reimporting identical bytes under a new filename or batch
reveals earlier exports and Auto avoids repeating them. Explicit edits of a saved
result remain available as revisions. A different encoding is a different fingerprint.
Available older exports are migrated when the server starts; sources already removed
before this feature cannot be reconstructed. Deleting a batch or automatic media
expiry keeps the history. Publication dates and links are local records of posts you
have already published; the app does not post them.

### Framing and export review

Open **Edit this result** to set the focal point of each source cut or unlocked
B-roll shot, choose crop/contain/blur framing, and adjust caption size and distance
from the bottom. Focal points describe positions in the original picture (0 is the
left/top, 1 is the right/bottom). They stay fixed for the shot; automatic subject
tracking is not part of this control. Framing-only edits preserve caption timing.

The editor's Instagram/TikTok interface guides are adjustable preview aids, not
baked overlays. Device and platform interfaces vary. Text overlap estimates help
identify captions, hooks, or callouts that need moving; inspect the rendered result
for exact font layout and subject framing.

After rendering, local checks inspect expected duration, dimensions, audio, black
sections and freezes. Suspected issues keep the export downloadable and mark it
**Needs review** with details. Intentional stills or silence can require human review.
Long-video checks sample bounded windows and say so; a passed technical check does
not assess editorial quality or platform eligibility.

### Measure and compare edits

In **History**, record whether the opening and ending work, how many B-roll shots
were accepted, caption corrections, and correction time. Use the same benchmark
case and a distinct editorial approach label when comparing versions. New editor
revisions record changed caption/shot counts and active correction time; manual
review values can replace those measurements when you have a more accurate count.
Unknown values stay blank and are excluded from averages.

Add dated Instagram or TikTok observations for views, average watch time,
completion, saves, shares and actual platform notices. Each export tracks one post
per platform; later observations update the same post. Summaries use the latest
observation per platform for each export, preventing repeated snapshots of the
same post from adding their cumulative views together. Platform results are also
reported separately. Watch time and completion
are weighted only where positive view counts are available. These comparisons are
observations, not evidence that an editing choice caused better distribution.

Download the measurement data as JSON or CSV. Review data remains with export
history after media cleanup. Run `npm run benchmark` for reproducible local media
diagnostics and read [the benchmark guide](benchmarks/README.md) to evaluate owned
or licensed speech examples with the same review rubric. Synthetic technical
fixtures do not substitute for reviewing real speech, stock relevance, or actual
post performance.
