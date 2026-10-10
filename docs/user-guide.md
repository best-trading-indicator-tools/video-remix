# Remix Studio user guide

[← Product overview and quick start](../README.md) · [Local MCP setup](local-mcp.md)

Detailed workflows, controls, setup options, and troubleshooting for the current private installation. For a first visit, start with the repository README.

## AI video upscaling

Install the local model once with `npm run setup:upscale`. This creates an isolated Python environment, downloads the checksum-verified Real-ESRGAN general x4v3 model, and runs an inference check. Apple Silicon Macs use Metal through PyTorch MPS; the default Linux/Windows installation uses CPU. A matching CUDA-enabled PyTorch installation in `.venv-upscale` is preserved by setup and supported by the worker. No media is sent to a provider.

1. Import your videos and choose **Apply changes to → Selected videos** (or **All videos**).
2. In Auto Quick setup, All settings, or Manual, set **AI video upscaler** to **1080p**, **1440p**, or **2160p · 4K**.
3. Render normally. Each video keeps its unrelated settings. The control also appears in Short clips and **Edit this result**, and finishing presets retain it.

Auto and Manual prompts accept “Upscale these videos to 4K with local AI.” Saved-result prompts can change or disable upscaling too. Review and apply the proposal, then render. Prompt planning still uses the app's DeepSeek key; the AI upscaling itself is free. Local MCP `create_draft` and `update_draft` accept `upscale: "1080"`, `"1440"`, `"2160"`, or `"off"` in both modes without a prompt-planning charge.

The target is a minimum short edge, preserving your chosen framing: landscape 4K is 3840×2160, portrait 4K is 2160×3840, and square uses 2160×2160. This overrides the ordinary Resolution selector while enabled. Larger native pictures keep their size and do not need an AI enlargement pass. Switching Off restores normal resolution behavior.

Real-ESRGAN reconstructs the selected main source frames before framing and added captions, titles, bands, or supporting shots. The original soundtrack follows the same cuts and speed. The model has a 4× reconstruction scale; very small inputs needing more than 4× also receive ordinary resizing to reach the target. Uploaded inserts/outros, supporting shots, and graphics are fitted normally. AI estimates detail, so fine textures can change and frame-to-frame flicker is possible. It cannot guarantee recovery of the original detail.

Use Manual's sample preview to compare quality; AI previews retain the source detail and chosen target rather than using the usual smaller preview. Large videos take longer and need temporary disk space for a lossless reconstructed video. Jobs share one inference slot within the running server to avoid competing for GPU memory. Frames stream through memory instead of accumulating as thousands of image files. Cancelled or failed jobs clean up their temporary files. If setup is missing or inference fails, the export reports an error rather than silently substituting ordinary resizing.

### Upscaler compatibility

| Computer | Default execution | Requirements |
| --- | --- | --- |
| Windows x64 (Intel/AMD CPU) | CPU | 64-bit Python; no NVIDIA card required |
| Linux x64 or ARM64 | CPU | glibc 2.28+; no GPU driver required |
| Apple Silicon Mac | Apple GPU, with CPU fallback | macOS 14+ and native ARM64 Python |

Use Python 3.10–3.13, preferably 3.12, and FFmpeg/ffprobe on PATH. The installer uses prebuilt wheels and version-specific NumPy pins. The pinned PyTorch wheels do not cover Intel Macs, 32-bit systems, or native Windows ARM Python; these need another backend before they can be supported. The official [PyTorch release matrix](https://github.com/pytorch/pytorch/blob/main/RELEASE.md) and [wheel files](https://pypi.org/project/torch/2.14.1/#files) determine these limits.

The app checks model integrity, executes a small AI inference, and checks FFmpeg/ffprobe plus the required video encoders and filters before declaring the upscaler ready. On Mac, use `brew install ffmpeg-full` and put `$(brew --prefix ffmpeg-full)/bin` first on PATH; the basic Homebrew formula omits text filters. This result is cached for one minute; failed checks are cached for five seconds. The selector reports **Apple GPU**, **NVIDIA GPU**, or **CPU**. Run `npm run check:upscale` for diagnostic errors. To isolate GPU problems, run `npm run check:upscale -- --device cpu`; set `UPSCALE_DEVICE=cpu` in the server's environment to force CPU exports (PowerShell: `$env:UPSCALE_DEVICE='cpu'`). Restart the server after changing its environment.

GPU allocation failures reduce inference tiles from 192 to 96 to 48 pixels. Other GPU failures, or memory failures at the smallest tile, retry the complete current frame on CPU and keep subsequent frames on CPU. The job status shows the active device. CPU memory retries are bounded; if CPU inference also fails, the export stops with an error. Fallback still runs Real-ESRGAN. It never silently substitutes simple sharpening or resizing. Cancellation applies while the worker is running or waiting for the shared inference slot.

CPU processing can be slow, especially in 4K. Start with a short 1080p preview on a modest laptop and leave enough disk space for the temporary lossless video. Tiling bounds model working memory, but a complete reconstructed frame still occupies RAM. A passing startup check proves the software can execute the model; it does not guarantee that every long or high-resolution input fits a particular computer.

The **AI upscaler compatibility** GitHub Actions workflow installs the model and runs real CPU exports on Windows, Linux, and Apple Silicon macOS, covering Python 3.10, 3.12, and 3.13. It checks bulk jobs, audio, output dimensions, cleanup and cancellation; separate fault-injection tests exercise GPU failures and memory retries. Hosted CPU checks do not certify every GPU driver. Local Apple GPU testing is still required for MPS changes.

### Find a topic

| Area | Detailed instructions |
| --- | --- |
| Start here | [Local setup](#run-locally), [Windows](#windows-setup), [Docker](#docker), [configuration](#configuration), [API keys](#api-keys), [interactive help](#interactive-tour) |
| Bring in footage | [Uploads, local links and URL imports](#import-long-recordings), [standalone Downloader](#url-downloader--free-extra-tool) |
| Edit videos | [Auto](#auto-workflow), [Manual](#manual-editing), [Short clips](#long-video-to-short-clips), [transcript editing](#edit-with-the-transcript), [prompt edits](#edit-with-a-prompt) |
| Finish the picture | [Captions](#caption-appearance), [black bands](#black-bands-and-text), [watermark removal](#watermark-removal), [your footage](#place-your-own-footage), [supporting visuals](#optional-b-roll-and-animated-cards), [speaker layouts](#free-active-speaker-framing-and-layouts) |
| Review and revise | [Drafts and bulk actions](#drafts-review-queue-and-library-browsing), [result editor and timeline](#faster-export-editing-and-review), [editorial checks](#independent-editorial-checks), [picture and sound checks](#review-the-finished-picture-and-sound) |
| Publish and measure | [Post copy and scheduling](#app-promotion-copy-and-postiz-scheduling), [History](#export-history), [outcomes](#export-settings-posting-outcomes-and-picture-history), [DeepSeek usage](#deepseek-usage-and-remaining-balance) |
| Connect and maintain | [MCP setup](local-mcp.md), [storage and backups](#workspace-storage-and-migration), [development](#development-and-checks), [troubleshooting](#troubleshooting), [error reports](#share-an-error-report) |

Remix Studio opens in **Auto remix** by default. Import your videos, start the batch, and download edits as MP4s or a ZIP. Editing, speech recognition, and rendering run locally. Auto's AI selection, writing, editorial checks, and repairs use your configured DeepSeek key; built-in selection remains available without it.

## Local MCP for Claude and Codex

Claude Desktop, Claude Code and Codex can control this local installation through
the `remix-studio` MCP server. Import videos, prepare bulk Auto or Manual edits,
append ending footage, change captions and bands, use the app's prompt feature,
and render into the ordinary **Exports** tab. No deployment is needed.

Run `npm run build`, then `npm run mcp:install` to register it with installed local
clients. Keep Remix Studio running and restart the clients to load the tools.
MCP drafts are shared between clients and are separate from browser selections
and unsaved browser settings. See the [local MCP guide](local-mcp.md) for
setup, example prompts and troubleshooting.

## API keys

Open **Settings** in the top navigation to add or replace your **DeepSeek**, **Pixabay**, **Pexels**, and **Postiz** API keys. Each field has its own **Save key** button. Configured keys stay hidden; leaving a field blank keeps its current key. Saving does not contact a provider or verify the key. New provider requests use the saved key without restarting the app.

Keys saved here take precedence over the corresponding environment variable. Your `.env` file and existing database are left intact. **Use environment key** removes an override and restores your original environment key; **Remove saved key** removes a key when there is no environment fallback. Model names and custom Postiz URLs remain in the server environment.

Saved keys are encrypted in `DATA_DIR/private/api-keys.enc`, with a local encryption key in `DATA_DIR/private/api-keys.key`. Keep both files together in private backups; losing the encryption key makes the saved keys unreadable. These settings belong to the current private installation. Run it privately; shared hosting still requires authentication and customer isolation.

## Interactive tour

A four-step introduction opens once per browser: import footage, choose output settings, review clips, and optionally edit from Claude or Codex through the local MCP connection. The last step's **Set up Claude or Codex** button opens connection instructions and bulk-edit examples; the same topic is available under **Edit from chat** in detailed help. Dismiss the tour at any point; completion is remembered across tabs and restarts. **Quick guide** and **How it works** replay it, while **Help with Auto / Manual / Short clips / exports / history** opens detailed help for the current workflow. **Browse all help topics** retains the complete reference tour. Closing help restores the original view without changing edit settings or starting renders.

Topics cover Auto preferences, black bands, captions, sound, reviews and supporting visuals; Manual framing, color, sound modifiers, captions, footage placements, presets, prompt edits and batch exports; the complete long-form-to-short workflow from discovery through sequences, tracking, pacing, approval and rendering; and History's settings, publications, review notes and measured outcomes. Controls that need a source, draft or export are explained beside their containing panel until that item exists. Presets are saved separately for each editing mode.

## Drafts, review queue and library browsing

- **Edit this result** autosaves changes to the workspace with a browser backup while the server is unavailable. Close and reopen to continue. **Resume saved draft** identifies unfinished work. Saving protects the export and its editing files from expiry; **Reset changes** discards the draft, and rendering a revision clears it. Conflicting browser/server drafts require an explicit choice before editing continues.
- Missing or changed originals open a recovery screen. Import the unchanged original and reconnect a matching source; matching uses its import fingerprint so saved cut timings remain valid. Older exports without fingerprints remain downloadable but need a fresh edit if their original is missing.
- **Apply changes to** has the same meaning in Quick setup, All settings and Manual. Choose this video, checked videos or all videos; future import defaults have a separate checkbox. Individual control changes preserve each video's other settings. The explicit copy-all controls copy the full configuration, and **Undo batch change** restores the previous state.
- **Add my own footage**, in both Auto Quick setup and All settings, follows **Apply changes to**. Check videos, choose **Selected videos**, then place a clip and enable **Add the whole clip at the end** to append it to each target's own ending. Adding, changing or removing placements replaces only the targets' footage lists and preserves their other settings. The panel names the video whose placements are shown. **Apply footage to N selected videos** also explicitly copies the displayed placements to the checked videos, regardless of the settings scope. **Undo batch change** restores the previous settings. Footage never becomes a future-import default; general copy-all settings controls preserve each video's footage.
- **Remix with a prompt** is available in both Auto views and follows **Apply changes to**. For example: “Append outro.mp4 in full and add black bands to every target video.” Upload the clip first. Each video gets its own proposal using its current settings, and the review lists the changes by video name. Apply the reviewed batch together, or undo it with **Undo last prompt**. Missing media, clarification or a failed request leaves the entire batch unchanged; videos already matching the request are skipped. Changing the target selection or settings invalidates an older proposal. Prompts affect existing target videos only, not future-import defaults.
- Exports have human decisions: **Unreviewed**, **Accepted**, **Needs edits**, and **Rejected**. Automated checks remain separate. Reviews also work for older completed exports without a History entry. **Review unreviewed** starts with undecided clips, **E / Edit** marks a clip as needing edits, and **Download accepted** bundles accepted clips matching your filters (up to 300 at a time).
- Source videos appear beneath **Select videos** (or **Choose a video** in Short clips). Click a card to open it, or check its box to work on several. **Search & filter** expands name/project filters; an active filter keeps its result count visible when collapsed. **More videos** and **Previous videos** appear when the list needs scrolling. **Add videos** opens a separate dialog for files, URLs and linked originals. You can also drop one or several video files anywhere in the **Source videos** panel, including over existing cards; the panel highlights and opens import progress for the batch. **Activity**, beside it, shows progress, retries, pause/resume and completed imports; its indicator highlights problems. Closing the dialog keeps imports running and preserves the video list, selected videos and unfinished URL/path inputs. Keep the browser tab open for file uploads. Newly imported videos join the end of the current list so existing cards stay in place. Assign a source project to organize its existing exports and future edits; individual History records can be reassigned separately. Exports and History filter by text, project, decision, publication state, format and dates. History filters apply before pagination. Earlier revisions are collapsed; History groups the revisions present on each page.
- On **Exports**, use the checkboxes to select up to 300 exports across collections. **Select all shown** respects filters and collapsed revisions; filtering or collapsing a selected card clears its selection. **Keep selected**, **Download selected** (ZIP with available SRT captions), and **Review selected** work on finished exports. **Delete selected** also works on failed, cancelled, or skipped exports, lists the exact selection for confirmation, and explicitly includes selected kept copies and saved editing drafts. Original videos, History records and scheduled posts remain. Running exports cannot be selected.
- Each export shows its expiry date or protection reason. **Keep collection** protects all completed exports in that collection. Clearing a collection confirms the number of files to delete, including results hidden by filters; kept exports and saved editing drafts are excluded. History records remain after files expire.
- **Delete export** removes one finished, failed, or cancelled export after confirmation, including its kept copy and saved editing draft. Original videos, History, and scheduled posts remain. **Cancel render** is available only while an export is queued or rendering.
- Short-clip drafts remain in browser storage and pin their original sources on the server. Removing those drafts releases that browser's pins. Keep browser data until those drafts are finished; clearing browser storage loses drafts and leaves their source pins in place to avoid deleting footage unexpectedly. **Source videos → Short-draft file protection → Release protection** can release these stale pins after confirmation.

## Mobile and tablet layouts

Workspaces and history scroll with the page. On phones and short windows, the
result editor becomes one scrollable sheet, with its render buttons at the end.
Larger editors keep independent preview and control columns. Dialogs adapt to
the visible viewport when the keyboard opens. See [responsive UI checks](responsive-ui.md)
for the layout rules and browser verification matrix.

## URL Downloader · free extra tool

Open **Downloader** in the top navigation to save full videos from URLs without
setting up an edit. This is an additional page: **Workspace → Add videos** keeps
its existing importer. Downloader files do not become editing sources or exports.

- Paste up to **100 links per batch** by default, including YouTube videos and
  **YouTube Shorts**, TikTok videos, and Instagram posts/Reels. Newlines, spaces
  and commas are supported. Duplicate video links within the batch are skipped;
  invalid links remain available for correction while valid ones can continue.
- **Strip metadata** is on by default. It removes source tags, chapters and
  software tags while retaining basic playback information. Ordinary H.264/AAC
  MP4s are cleaned without re-encoding their picture or soundtrack. Other codecs
  and videos needing rotation are converted to a compatible MP4. Uncheck it to
  save the imported file unchanged. The full video and original audio are kept;
  no AI provider or credits are used.
- Follow each video's preparation, download and cleanup progress. When a platform
  reports a required wait, a countdown is shown before the download starts.
  Retry a failed download, or cancel pending work.
  Processing continues while the app server runs, including after leaving the
  page. The queue and completed files survive app restarts.
- Save a single **Download MP4**, **Download all ready** as a ZIP, or select up to
  **100 ready videos** for a ZIP. Duplicate titles receive unique numbered names.
  Files are available for **48 hours**, and the downloader holds up to 200 items.
  Removing a ready download asks for confirmation and leaves saved computer
  copies and editing sources alone.

The tool uses the same platform downloader, login cookies, file limits and
network recovery as the workspace URL importer. A platform restriction or login
requirement affects both tools. **Help with downloader** opens its interactive
help topic.

## Import long recordings

- Import up to **100 videos per batch** by default (`MAX_FILES`, 1–100), with up to **200 source videos** in the workspace. Completed import cards do not occupy unfinished-import slots. If one selected file cannot be queued, the other files continue and its error stays visible beside the uploader.
- **Browse or drop videos:** source imports accept up to **50 GiB per file** by default, including 10–40 GB recordings. Each file transfers in 8 MiB chunks with confirmed progress. Pause an upload, or select the same unchanged file after reloading to resume it. Imports continue while you open Exports or History; keep the browser tab open during transfer.
- **Link files on this computer:** paste one absolute video path per line. On Mac, select files in Finder and press **Option + Command + C** to copy their paths. The app reads the originals through managed links, without copying a 40 GB file. Removing or expiring an import removes the link, leaving the original intact. Keep originals at the same path and unchanged until exports finish. In Docker, the paths must be visible inside the container.
- **Import from a video URL:** an alternative to uploading a file, directly below the uploader. Paste a regular YouTube video URL (`https://www.youtube.com/watch?v=VIDEO_ID`), a Shorts URL (`https://www.youtube.com/shorts/VIDEO_ID`), or a share link (`https://youtu.be/VIDEO_ID`). TikTok videos (including share links) and Instagram Reels/video posts work too. Import one link or multiple links separated by new lines, spaces or commas. The count and **Import N videos** button show the batch size (up to 100 by default, controlled by `MAX_FILES`). Duplicate video links in the batch are skipped, and invalid entries stay available to correct while the valid links import. Downloads join the same workspace for Auto, Manual and Short clips, with progress and cancellation. If a platform requires login, supply an exported cookies file as described below, or save the video yourself and browse to the local copy. Profiles, playlists, live streams and arbitrary website URLs are not accepted. For multi-video posts, only the first item is imported.
- **Preparation runs in the background:** video metadata, a preview image, and a streaming content fingerprint are prepared with visible progress. Two videos can be analyzed at once. The fingerprint reads the full file to recognize earlier exports, so large originals still take time to prepare.
- Interrupted uploads and pending analysis survive backend restarts. Unused import sessions expire after 48 hours. Source retention starts when the source is ready; export retention starts when rendering finishes. Both follow `RETENTION_HOURS`. **Keep** protects exports and their editing files from expiry. Available disk space is checked against unfinished uploads; copied sources and exports still need local storage.

Imports support MP4, MOV, M4V, WebM, MKV, AVI, and MPEG, up to 24 hours long. Browser playback depends on the video codec; FFmpeg supports more formats than browsers. The separate B-roll/legacy multipart limit remains `MAX_FILE_SIZE_MB` (500 MiB by default).

If the workspace drive stops responding, its free-space check fails after four seconds with a retry message. Imports keep their disk-space protection, including when available space is zero. Pending writes retain their queue lock until they finish. On Windows, use a local, connected workspace drive and the normal `.exe` downloader installed by `setup:imports`; explicitly configured JavaScript downloader wrappers are launched through Node.

Link imports use [yt-dlp](https://github.com/yt-dlp/yt-dlp), FFmpeg, and this app's Node runtime. Run **`npm run setup:imports`** once to install the downloader in `.venv-imports` (Python 3.10+ required); run it again to update platform support. An existing `.venv` or PATH installation is also supported, or set `YT_DLP_BIN`. Docker includes the downloader. Downloads run on the server, can continue after closing the tab, and restart automatically after a backend restart. They share the import queue's two processing slots and file-size limit, with disk-space checks and a 45-minute timeout. Finished downloads are kept for analysis; interrupted download bytes are discarded before retrying. Browser profiles are never read automatically.

For links that require login, place your exported **Netscape-format** `cookies.txt` in the project folder on the computer running the app, then use **Retry import**. The app checks that file first, then `cookies.txt` inside `DATA_DIR` (normally `data/cookies.txt`). To use a different file, set `YT_DLP_COOKIES` in `.env`, for example `YT_DLP_COOKIES="C:/Users/YourName/Downloads/my cookies.txt"`, and restart the app. An explicit setting takes precedence and must point to a valid file; it never silently falls back to another file. Cookie files are optional when downloads already work. The app uses a temporary copy for each download and deletes the copy when the download finishes or fails. Keep the exported file private and out of version control. Login errors and copied support reports say whether cookies were loaded: if loaded cookies are still refused, sign in to the platform, confirm the video plays, export fresh cookies and retry. Cookies do not guarantee that a platform will allow a download; use a local copy if it continues to refuse it. See the [yt-dlp cookie format documentation](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).

Failed link imports have a **Retry import** button that requests a fresh download from the saved URL in the same queue entry. A temporary server refusal, interrupted connection, or rate limit is reported separately from an explicit sign-in requirement. Retry is available without pasting the URL again; an already completed import cannot be retried into a duplicate source.

## Auto workflow

1. **Import your videos.** Drop multiple files into the workspace together.
2. **Auto remix all.** Press the Auto remix button to process every uploaded video independently. The default is one vertical 9:16 version, up to 45 seconds, with the original voice.
3. **Review and download.** Follow the editing stages in Exports, preview the finished clips, read what changed, and download individual MP4s or the batch ZIP. Captioned exports also provide downloadable SRT files.

### Quick setup and your style

Auto opens on **Quick setup**, with choices that follow **Apply changes to**.
Choose this video, selected videos or all videos; future imports have a separate
checkbox. Choose **where you will post** (TikTok, Reels & Shorts 9:16, Instagram feed 4:5,
square, or YouTube 16:9), then choose **Keep the full video** or **Let Auto choose a shorter clip**.
Full video makes one export per source, keeping all its footage in order, including pauses and the original voice.
A 15-second source stays 15 seconds and a 30-second source stays 30 seconds in the same batch.
Your added footage adds time: appending a 17-second clip to a 50-second original makes a 67-second export.
Captions, framing, sound and supporting visuals still follow your preferences; editorial review checks without recutting.
Shorter clips let you choose a **maximum excerpt length** (15–90 seconds), **how many
clips per video**, and **what changes between versions**. Auto can select less than the maximum;
inserted footage adds time beyond that limit. Existing saved setups retain excerpt selection until you choose full video.
**All settings** in the
panel header exposes every Auto control with the same settings scope; your choice
of view is remembered.

**Your style** keeps your caption look, black-band layout, pacing and sound in one
place. Adjust them in All settings, then choose **Save this look as my style**.
The style is applied at once
to every video in Auto and Manual and saved for new imports. Each video keeps its
own cuts, length, versions, band text and supporting visuals. In Manual, a pinned
sound look or None carries over; Auto's measured sound has no Manual equivalent, so
Manual keeps its own sound in that case. Short clips starts new pacing reviews from
your style's pacing. The style is stored in this browser.

For shorter clips, optional output preferences let you enter **any whole-number maximum excerpt length from 1 second**, type **1–10 maximum versions per video**, and choose **9:16, square, 4:5, 16:9, or original framing**. The maximum limits the source excerpt; inserted footage adds time. Length mode and custom limits are saved per video and survive reloading.

Select a source video and use **This video** to change only its Auto settings, including format, length mode, narration, supporting visuals, selected B-roll clips, and maximum versions. **Copy all Auto settings to all N videos** copies the selected video's complete settings to the other sources. Future imports change only when their checkbox is enabled. One Auto remix click processes the selected batch, with each video using its own saved settings. Manual settings remain separate.

**What changes between versions** decides how versions of one video differ. **A different moment** (the default) looks for another excerpt each time. **New angles on the same moment** keeps version 1's excerpt and builds up to three more versions from it, each with its own opening, on-screen text and caption look:

- **Version 1 · Classic:** the moment as Auto normally edits it.
- **Version 2 · Conclusion first:** replays the moment's conclusion as a cold open, then plays the whole moment. DeepSeek quotes the concluding sentence verbatim; the app finds those words in the transcript, otherwise it uses the final sentence. The replay keeps paced pauses removed, lasts 1–7 seconds, and must fit within the target length; otherwise only the headline leads with the conclusion.
- **Version 3 · Question first:** opens on the question the moment answers.
- **Version 4 · Key points:** numbers the spoken points on screen, in the order they are spoken.

Angle versions reuse version 1's footage on purpose, keep the original voice (narration is not available in this mode), and make no extra selection request: each angle is one packaging request with the same grounding rules and editorial checks. Question and key-point angles need DeepSeek to write their text; without it, or when version 1 did not choose a moment, that version uses another moment and says why in its notes. A caption style you choose applies to every version; otherwise angles use the Punch, Editorial and Box looks. When the source keeps its own baked-in captions, question and key-point angles are skipped because they would add no on-screen text.

The version count is a **maximum**. Auto normally skips an extra version when it would repeat an already completed cut from the same batch. Choose **Generate anyway** on that skipped job to explicitly make another version with its selected settings and B-roll options. Earlier exports in History never block a new batch: Auto prefers unused excerpts when possible, and adds a reuse notice when it uses earlier footage.

With the local speech model ready, Auto transcribes speech, selects a focused excerpt, tightens longer pauses, and prepares an opening hook and timed captions. Automatic framing and audio balancing finish the cut. The **Sound** preference decides what happens to the tone of that audio: **Auto** measures the selected speech on this computer — the level of every half-second window, and the energy in four frequency bands — and applies the closest-fitting sound look, naming the look and what it heard in the export notes. Pin a specific look to use it for every version instead, or choose **None · keep original audio** to skip all sound treatment, loudness normalization, cut fades and replacement narration. None keeps the original voice and volume while audio follows the video cuts; MP4 export still re-encodes the selected audio. Automatic measurement runs only where speech was recognized, because a continuous music bed or room tone has no pauses and its steady level would read as noise; loudness is evened out across the cuts unless Sound is set to None. DeepSeek planning helps choose the excerpt and write hooks and callouts from the transcript. Callouts are shown when their words match the edited speech; unmatched ideas are omitted. Auto preserves the source's color and does not add arbitrary noise, speed changes, or mirroring.

If speech or the speech model is unavailable, Auto falls back to scene and timing edits using the source footage. Captions require a usable transcript. The export notes explain which tools were used and any fallback.

### DeepSeek recovery

DeepSeek requests automatically try up to four times within two minutes (or the
remaining time allowed by the editing stage). Temporary connection/service
errors, rate limits and incomplete JSON are retried with backoff. The server
respects `Retry-After`; truncated answers get a larger, bounded response budget.
Editorial checks also retry invalid schemas and unverifiable source quotations,
without changing the saved edit or assuming a passing verdict. Authentication
and account-credit errors stop immediately with an actionable message.

If recovery is exhausted, the export remains available and the editorial warning
shows the reason and number of attempts. **Retry editorial check** checks the
saved edit again without rendering. Cancelling stops requests and backoff waits.

### Captions already in the footage

**Captions → Auto · avoid duplicates** is the default. Before adding captions,
Auto samples up to 12 frames from the selected source intervals and uses local
Tesseract OCR to look for changing text that matches the nearby speech. When
captions are detected, Auto keeps the original text and voice, omits additional
captions, hooks and callouts, and continues the B-roll workflow. The check uses no
paid API and does not blur, erase or reconstruct any source pixels.

Choose **Keep original · add none** to skip all added captions, or **Add new
captions** to explicitly generate them. These choices are saved per source video.
Detection is sampled and can miss text; if OCR is unavailable, the matching
language model is missing, or the evidence is uncertain, Auto adds no captions
and explains the result. Install the matching Tesseract language data for footage
in languages other than English. Results are cached by source, selected cuts and
transcript in `data/analysis/source-captions`.

For an earlier double-caption export, open **Edit this result → Captions → Remove
added captions**, then render the revision. This removes only the app's added
captions; text baked into the source remains. The saved decision survives later
cut changes and automatic editorial corrections. Clean removal of baked-in text
would require reconstructing the image behind it and is not part of this feature.

Use your own footage or footage you have permission to repurpose. Review the resulting cut and captions before posting. Editing or changing file metadata does **not** guarantee that TikTok, Instagram, or another platform will classify a video as original, recommend it, or permit monetization.

### Black bands and text

**Black bands** has its own always-visible **Auto → Black bands & text** section, above Output preferences and Supporting visuals. It is also available in **Manual → Frame it right**,
and **Edit this result → Framing & caption placement**. Choose your output format,
then reserve adjustable black space above and below the picture. **Keep the whole
picture** preserves landscape footage as a mini widescreen; a portrait original is
scaled down without cropping, leaving black space at its sides too. **Fill the window**
crops the original to a wider window; use the subject position controls to frame it.

Write persistent white text in either band, usually a headline above. Text wraps and
shrinks to fit. The bands and their text stay visible during B-roll and inserted clips.
Speech captions keep their separate controls, so leave the bottom band text blank if
captions occupy that area. Hooks and callouts appear over the video window. Your written
band text is included even when Auto is set to keep original speech captions. Finishing
presets save band sizes and styling while retaining each video's own words.

### Watermark removal

**Auto → Quick**, **Auto → All settings** and **Manual → Essentials → Frame it right** include a
**Watermark removal** checkbox, off by default. Enabling it opens the original
video in the main preview. Use **Select** for a movable, resizable box, **Brush**
for irregular shapes, **Erase** to subtract from the mask, and **Undo** to restore
the last change. Brush size is relative to the original picture.

Areas save automatically as you draw. **Close watermark editor** returns to the
main preview while keeping removal enabled for export; it does not start a render.
Use **Open watermark editor** to adjust the saved areas or preview removal.
**Undo** reverses edits made in the current watermark session and keeps removal
enabled. Switching OFF/ON starts a fresh undo history and retains only the areas
currently saved; marks removed with Undo or Clear stay removed.

- **Whole video · fixed area** applies Area 1 to every frame, including frames
  after a temporary label disappears. Use a time range for a temporary mark.
- **Time ranges · only while visible** saves up to 16 areas with start/end times
  on the original video's clock. Scrub or enter an exact timestamp, then use
  **Add area at playhead** when a mark changes position. Areas remain fixed within
  their ranges; there is no automatic motion tracking.
- **Stop this area at playhead** sets the selected area's end to the current
  source time and switches to time ranges.
- **Area fill → AI reconstruction · LaMa (local)** is the default for new areas.
  It reconstructs the marked background on each frame using a free local model.
  Existing saved areas retain their previous fill; select LaMa to upgrade them.
- **Area fill → Blend surrounding pixels · fast** keeps the lightweight FFmpeg
  fill available without installing a model.
- **Area fill → Copy from a clean frame** uses the same region from a selected
  original frame. Scrub to a nearby clear frame, then **Use playhead as clean
  frame**. This retains real texture on a steady background; the patch is static
  and will not follow camera or subject movement. Each area can use its own frame.
- **Edge softness** blends a narrow margin around the selection while keeping
  the selected core fully covered. Set it to zero for a hard mask boundary.
- **Preview removal · 3s** renders a local sample from the playhead in the main
  player. **Back to marking** restores the source for comparison. The colored
  selection is a mask, not the cleaned result.

Install LaMa once on the machine running the video engine:

```sh
npm run setup:watermark
```

This creates a separate `.venv-watermark` Python environment and downloads the
196 MiB TorchScript model after verifying its SHA-256 hash. Python 3.12 is
recommended. The model uses the [Apache 2.0 license](https://github.com/advimman/lama/blob/main/LICENSE),
which permits commercial use; attribution and the license are in `scripts/models/`.
There are no API keys, credits or per-video fees. Rendering stays offline and never
downloads models automatically. The other two fills work without this installation.

LaMa uses Apple Metal when available, with CPU fallback. Only one local model worker
runs at a time across previews and exports. It streams frames, processes a surrounding
crop at a maximum 512-pixel model size, and stores only lossless replacement patches.
The export keeps its original requested dimensions and audio. Masks are composited
at full resolution, preserving pixels outside their softened boundaries; progress
includes reconstruction, and cancelling also stops its decoder and patch encoder.

LaMa can give less blurry results than surrounding-pixel blending, but it cannot
recover hidden truth: large labels, faces and moving detail can look invented or
flicker between frames. Cover the whole label, including any background box, and
preview before exporting. A matching clean frame can retain real texture instead.
This is a general method for each video's selected areas, with no clip-specific logic.
Selections covering more than 25% of the picture are rejected before analysis or
review starts, with guidance to adjust the marked area. Selection errors stop the
job immediately instead of repeating the same export automatically.

Masks are stored with the individual video's settings, retained when disabled,
and preserved in saved export revisions. They are excluded from styles,
finishing presets, copy-to-all and future-import defaults. Timed masks follow
trims, reordered/repeated source cuts and playback speed, before cropping, color,
black bands, added captions and supporting footage. Existing live edit previews
show the source until a cleaned sample or export is rendered.

### Caption appearance

Choose a look in **Auto → Caption appearance**, **Manual → Captions → Caption appearance**,
or **Edit this result → Captions**. Clean, Punch, Editorial and Box presets are starting
points; customize the font family, size, text color, bold/italic/case, outline, shadow,
letter spacing, alignment, bottom spacing and background opacity. A background box
replaces the outline. The type sample and draft preview update immediately; render
a revision to check the final placement and wrapping in the MP4.

TikTok Sans, Poppins, Anton and DM Serif are bundled locally with their font licenses. Choose **Font family → TikTok Sans**, or ask a prompt to “Use TikTok Sans captions.” Its regular, bold, italic and bold italic faces work in previews and exports; the setting also follows Auto's selected-video scope. Classic
sans keeps the existing system-font fallback. Size scales with export resolution.
One style applies to all added captions, including imported SRT cues; embedded SRT
font overrides are replaced by that style. Caption wording and timing stay saved
unchanged. Baked-in source captions cannot be restyled. Finishing presets and saved
revisions retain the look, and prompt edits can change individual style properties.

Under **Caption appearance → Cyrillic lookalikes**, choose **Only listed words** and
enter words or phrases (one per line or comma-separated), or choose **All caption text**.
The before/after preview shows similar-looking Cyrillic letters in place of matching
Latin letters; this is a spelling effect, not translation. Whole-word matches ignore
case. TikTok Sans supports the replacement characters. The effect starts off and
applies to added captions in previews and MP4 exports, including imported SRTs.
Original editable captions, downloadable SRT text and speech timings stay unchanged.
Built-in looks preserve this setting; finishing presets, My style and saved revisions
retain it. In Auto, choose **Apply changes to → Selected videos** before changing it
to apply it in bulk (in Quick, open **All settings** for caption appearance).
Prompts can also request “Use Cyrillic lookalikes only for Sample-12 in captions”
or “Turn off Cyrillic lookalikes.” Changing spelling does not guarantee a platform's
moderation or recommendation outcome.

Black-band text has its own color, size and Cyrillic-lookalike controls for each band.
In Auto Quick or All settings, Manual, or a saved export's prompt editor, try:
“Add BPC157 in cyrillic white font medium size font in upper band.” This enables
the bands and displays **ВРС157** in white, centered in the upper band throughout
the video. Medium is 5.4% of the shorter canvas dimension, shrinking if needed to fit.
The editable text stays `BPC157`; the lower band and speech-caption styles stay
unchanged. In Auto, **Apply changes to → Selected videos** applies the reviewed
prompt to the checked videos. Per-band appearance also follows My style and presets.

### DeepSeek usage and remaining balance

**Exports** shows a **DeepSeek credit balance** panel with the account's remaining
USD and/or CNY, including granted and topped-up funds. **Refresh balance** reads
DeepSeek's balance API; the checked time is shown. The balance is account-wide,
including other applications using the same account. CNY is kept in CNY, without
an invented USD conversion. A missing key or provider error shows an explanation,
never a guessed zero balance.

Each export card and preview shows recorded DeepSeek tokens and an **estimated USD
cost**. Expand it for input, cached-input and output totals, models and request counts.
The estimate uses the [published off-peak and peak rates](https://api-docs.deepseek.com/quick_start/pricing/)
verified on October 7, 2026; the range allows for the applicable billing schedule.
Provider prices may change, so this is not an invoice. Unknown model prices and
missing usage reports are explicitly marked incomplete. DeepSeek reports tokens
and a monetary balance, not a separate credit count.

Usage is saved per export from new API requests, including retries, follow-up
reviews and prompts in the saved export editor. Separate revisions have separate
counters. Prompts before an export exists are outside its total; shared/cached
analysis is counted on the export that made the API request, without charging it
again on reuse. Failed or interrupted requests can lack usage reports. Older
exports cannot be backfilled and show **usage not recorded**. The app does not
subtract account balances to attribute costs to simultaneously running exports.

### Complete-idea selection

Auto considers shorter sentence-aligned ideas and their neighboring context,
including questions, answers, and qualifications. With the configured DeepSeek
text model, a separate discovery pass proposes contiguous source-unit ranges;
the app validates their original timestamps and duration before selecting a short.
The heading is then written from only the selected excerpt.

Discovery makes at most three DeepSeek requests within a 120-second budget and
caches results by source transcript, language, model, and duration preference.
Long recordings may be sampled across opening, middle, and ending sections; export
notes disclose that coverage. An empty sampled result never dismisses the whole
recording. Unavailable or invalid model responses use sentence-based selection.
Valid complete-source assessments can return fewer shorts when no standalone idea
fits. Model proposals still need editorial review; their source anchors establish
where the words came from, not that the model's judgment is correct.

### Independent editorial checks

**Output preferences → Editorial review** offers **Check and repair** (the default
for new settings), **Check only**, and **Off**. Each source keeps its own preference.
The checker reviews the saved cut before rendering. It checks whether the opening has
enough context, the ending finishes the idea, headings and callouts are supported,
the source meaning is preserved, and captions match the selected speech. Findings
include validated source quotes and timestamps. Exports, the editor, and durable
History show the report separately from technical media checks and human verdicts.

For edits with selected speech, the checker uses the configured DeepSeek text model and makes one bounded request. It
never treats unavailable AI, missing source evidence, a malformed response, or an
uncertain judgment as a pass. Partial transcript coverage is disclosed. It does
not inspect picture content in transcript mode or listen to the rendered audio; narration and
replacement audio need manual review. An edited draft has no current report until
its revision is rendered with checks enabled. Source text is treated as data.

Without usable selected speech, the checker uses **DeepSeek Flash visual review**.
It extracts up to 16 timestamped source frames from the opening, middle, and ending
of up to four cuts, plus neighboring source context, and sends those images to
`DEEPSEEK_VISION_MODEL` (default `deepseek-flash`). The API accepts image input;
the app supplies frames in playback order rather than uploading an MP4. This works
for silent screen recordings, demonstrations, and other videos without transcripts.
Reports identify visual observations and sampled coverage separately from speech
quotations. Unreadable frames, unsampled cuts, additional visual layers, or captions
that still need speech verification keep the review partial. Visual review does
not certify unsampled motion, rendered composition, or audio, and does not attempt
speech-based automatic repairs.

If a check cannot finish, its report shows a safe reason such as a request timeout,
account/configuration issue, response-format error, or unverifiable source evidence.
Older reports may not have recorded the precise cause. **Retry editorial check**
reviews that saved export again using DeepSeek and updates its report in Exports
and History. It does not render a new video, change the edit, or attempt repairs.
For transcript reviews, the saved plan and transcript are enough even if the
original media has expired. Visual reviews also need the original video available.

The reviewer is a separate request to the same configured model, so it can still
miss problems or agree with an earlier mistake. A passing report is advisory and
never records human acceptance or approval to publish. Real-model smoke checks and
human review measure judgment quality separately from the automated software tests.

Run `npx tsx benchmarks/editorial-smoke.ts --run-deepseek` for the optional
authored-text smoke test. The explicit flag permits at most four paid DeepSeek
calls on synthetic examples, using no user media. Add `--held-out` to include two
additional examples, for at most six calls. Without `--run-deepseek`, it lists the
fixtures without contacting the provider.

The 2026-09-15 `deepseek-flash` run initially flagged a valid heading and returned
an unavailable result for a removed-negation example. After a general prompt
refinement, all four original examples matched their expected checks. Of two
held-out examples, an unsupported daily-watering instruction was correctly flagged,
while a valid seedling-topic heading returned **unavailable**. That is **5 of 6
expected outcomes observed in that run**, including a remaining failure to obtain
a usable judgment; it is not a general accuracy estimate. The production build
and all **340 software tests** passed separately. Initial and final observations
are saved in the [authored DeepSeek results](../benchmarks/results/deepseek-editorial-2026-09-15.json).

### Bounded automatic repair

With **Check and repair**, concrete, source-cited findings can trigger at most two
small correction proposals within a 120-second review/repair budget. Allowed
changes are a source-quoted heading, a modest extension to an existing cut that
restores nearby words, or a source-grounded caption correction. Extensions retain
all originally selected speech, preserve sequence order, add at most three source
seconds per boundary and six seconds overall, and respect your duration cap.
Supporting footage and overlay timing must stay intact.

Every proposal passes the existing edit-plan validator and a fresh independent
editorial check. It is kept only when targeted findings decrease without new,
worse, or missing checks. An invalid proposal, unverified improvement, unavailable
model, timeout, or exhausted budget leaves the best reviewed edit in place and
shows what still needs review. Human-edited revisions and replacement/narrated
audio receive checks only. Rendering retries reuse the saved correction history
without granting a new repair budget.

The final plan drives the actual render, captions, and export title. Reports retain
attempt outcomes, proposed changes, before/after findings, and the stopping reason
in Exports and History. Automatic attempts do not count as human corrections or
create extra user revisions. **Accepted unchanged** means you accepted the final
automatic output without making human edits; a successful model check never fills
in that verdict for you.

To measure improvement, review representative **Check only** and **Check and
repair** exports using the same human rubric in History. CSV/JSON retain mode,
policy/model, automatic attempt outcomes, and revision relationships alongside your
verdict and correction time. Missing verdicts remain unknown. These measurements
can compare reviewed outputs; real creator reviews are still required to establish
acceptance rates, missed useful moments, and platform performance.

Run `npx tsx benchmarks/editorial-pipeline-smoke.ts --run-deepseek` to exercise
discovery, selection/packaging, and grounded repair with authored text. This opt-in
runner allows at most **8 paid requests / 180 seconds**, uses a temporary discovery
cache, and does not read user media or render a video. Without the flag it makes
no calls. The recorded live run used six requests: camera-advice discovery and
packaging succeeded, and one repair changed “This method always works” to
“This method does not always work”. The separate follow-up check passed and the
source cuts stayed unchanged. These are observations on two authored scenarios;
they do not measure creator acceptance or rendered-video quality. See the
[saved pipeline results](../benchmarks/results/deepseek-editorial-2026-09-15.json).

## Optional B-roll and animated cards

Use **Auto → Output preferences → Supporting visuals**, or **Manual → Supporting visuals** below the editing controls (available in every tab). Each source has its own checkbox: choose **Pixabay**, **Pexels**, **HyperFrames**, **Remotion**, or any combination. Leave all unchecked to keep only the source footage. Selections and the combined shot target are saved per source video and can be applied to the whole batch.

- **Pixabay** finds existing moving stock footage. Choose any stock video or animation-only stock results. Set `PIXABAY_API_KEY` in the backend environment to enable search; get a key from the [Pixabay API page](https://pixabay.com/api/docs/). Optional DeepSeek matching turns spoken ideas and neighboring context into concrete visual searches and checks the visible relevance of a shortlist. Stock is checked locally for sustained motion in the output crop.
- **Pexels** searches existing moving videos using `PEXELS_API_KEY` in the private `.env`. It can be selected alongside Pixabay and preserves creator/source credits.
- **HyperFrames** renders illustrated explainers locally in a dark palette.
- **Remotion** renders the same explainers locally in a paper-and-teal palette.
- **My B-roll** inserts relevant clips from your uploaded library. Select your own or licensed videos for each source; the original audio continues underneath.

HyperFrames and Remotion are animation/rendering tools, not stock libraries. DeepSeek now plans a useful visual for each suitable spoken moment: a concrete vector illustration, a two/three-part process diagram, a comparison, or a bar chart. Each element cites words from that exact output interval; neighboring sentences provide context but cannot supply missing evidence. Word timestamps align element reveals when available. Charts require literal same-unit numbers and labels in the speech, use a zero baseline, and never estimate unspoken data. These are explanations of the speaker’s claims, not independent evidence. Authored vector drawings and layouts are rendered locally; AI supplies validated scene data, never executable code. Unsupported, unreadable or unavailable plans keep the source picture instead of generating a generic text card. Speech captions remain above the supporting visuals. Mixed selections take turns, giving underrepresented sources priority. If one source has no suitable shot or its renderer is unavailable, other selected sources can still fill the target. Unselected sources are never substituted. Very short edits or a target smaller than the number of selected sources may not include every source.

The local renderers do not need API keys; semantic scene planning uses the existing private DeepSeek key and its normal text API billing. No cloud render or generative-video service is called. [Remotion's 4.x license](https://github.com/remotion-dev/remotion/blob/v4.0.525/LICENSE.md) permits free use for individuals, nonprofits and companies with up to three employees; other commercial organizations need its company license. HyperFrames's hosted MCP is a separate service and is not used here.

`npm ci` installs the pinned renderers and Chromium. If browser installation was skipped, run `npm run setup:visuals` once, or set `PRODUCER_HEADLESS_SHELL_PATH` to an installed Chromium executable. The card compositions include bundled fonts. `npm run build` also bundles the fixed Remotion composition for production; the Docker image includes it. Development builds that composition once per API process. Unavailable renderers and failed cards are reported in export notes.

Each saved card records its renderer, scene type, explanation, quoted speech and element reveal times. **Edit this result** previews the actual saved animation, identifies HyperFrames or Remotion, and lets you disable it or adjust its timing. Caption-only revisions reuse those exact MP4 files.

Uploaded B-roll clips persist until you remove them from the library; the ordinary source/export retention timer does not delete them. The library holds up to 100 clips and uses `MAX_FILE_SIZE_MB` for its per-file upload limit. Remove unused library clips to reclaim disk space. Clips referenced by active jobs cannot be removed until those jobs finish or are cancelled.

In Manual, these options decorate your chosen trim or cut sequence without selecting new source cuts or changing your speed, framing or audio settings. Speech matching follows the trimmed, reordered and speed-adjusted timeline; replacement audio is matched on its own output timeline. Without usable speech, local library matching falls back to the source filename. Supporting shots are assembled during the full export and are not included in Live or five-second previews. Manual preferences remain separate from Auto, persist per video, work with **Apply settings to all videos**, and are included in finishing presets (selected library clip IDs stay with each video).

Supporting visuals are **off by default**. **Total supporting shots** accepts **1–10**, defaults to **4**, and requests that many visuals in total across the selected sources. Up to **three passes within eight minutes** keep successful placements and search for the missing ones. Later passes try more stock pages and alternate visual ideas, and fit shorter shots into unused intervals. A failed card tries another selected renderer. Unselected sources are never enabled to fill a count.

The first pass leaves the opening on the speaker and spaces cutaways generously. Filling remaining places can use 1.5-second shots, 0.15-second gaps, while respecting the selected maximum supporting-visual coverage (60% by default). Cards retain a reading-time check and avoid the opening heading. Main audio and captions continue. Stock still needs relevance and sustained motion; impossible counts or unavailable providers/renderers produce an explicit **placed/requested** result and reason.

Each pass considers the remaining count plus two backup ideas, at most 12 ideas and 36 download/inspection attempts. Each idea searches up to two queries on each selected stock provider; later passes use pages two and three. Three passes therefore inspect at most 108 downloaded candidates, subject to the shared time budget. Search responses are cached for 24 hours. Downloads are capped at 40 MiB per clip (or the configured upload limit if smaller). Used clips and a bounded set of alternatives are retained with the saved edit plan. Credits link to each creator's source page in Exports and appear in the batch ZIP's `export-settings.json`.

### Stock relevance and AI B-roll matching

Pixabay and Pexels always use **Meaning & visual matching** with `DEEPSEEK_API_KEY`. Old saved keyword presets upgrade automatically for new searches; uploaded-library-only workflows still offer local filename/tag matching. This uses [DeepSeek Flash's image understanding](https://api-docs.deepseek.com/guides/vision/) to match the visible content of your B-roll to the edited speech. The default model ID is `deepseek-flash`; `DEEPSEEK_MODEL` can override it with a compatible vision model.

1. On each search pass, prepare the remaining requested number of semantic search briefs plus up to two backup ideas (maximum 12) in one bounded text request. Each brief can include one simpler alternative query. Rank up to 12 search results per query by relevance before portrait suitability, merge duplicate assets, and inspect up to three candidates per spoken idea. Download the highest usable crop resolution within the 40 MiB cap and 1920-pixel download bound. A small aspect-ratio rounding difference cannot favor an SD file over HD. Reject files whose output crop has fewer than 360 pixels on the short side or 640 on the long side, checking the actual downloaded media too. Inspect up to five short windows locally for actual motion and reject static/black footage. The vision model sees three frames from the selected output crop. Uploaded library clips retain their short midpoint inspection, 20–36 clips per edit depending on the target.
2. Ask the vision model what is visible, rejecting unclear subjects from heavy blur, pixelation, or a crop that removes the action, and cache the descriptions locally. A softly blurred background around a sharp subject is fine. Stock descriptions are reused across jobs using provider identity, the downloaded content hash, interval, crop and model. Semantic briefs are cached by transcript context, text model and target count; changing the count reuses existing visual descriptions. Set `DEEPSEEK_TEXT_MODEL` to override the text model independently.
3. Match transcript phrases to those descriptions by meaning, keeping the search brief separate from the observed visual evidence. For example, "take a break outdoors" can match footage of a person walking in a park even if its filename is `IMG_4821.mp4`. Relevant illustrative shots are allowed; search intent alone cannot establish what a clip shows. The final check uses stable clip ordering and labels, with temperature zero, to reduce variation when the same footage is downloaded again. Weak matches are still rejected.
4. Insert only suitable matches, using the inspected window at the corresponding point in the final speech. Recheck motion in the exact final stock interval after trimming. Cutaways last at most 3.6 seconds, with spacing and total screen-time limits. The main narration continues; captions stay visible. Export notes explain why each AI-selected shot was used.

Selecting stock footage enables paid text and image requests to DeepSeek. Library-only AI matching remains optional. It sends sampled **B-roll frames** and **transcript excerpts** to that service; source audio and full video files are not uploaded. Rendering, transcription, and animated cards remain local. Without a usable transcript or a suitable match, or when the API is unavailable, the original picture is kept. An AI rejection never forces a weaker keyword match.

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

**Render new revision** creates one corrected export and preserves the previous
version. It reuses saved narration and footage without calling the planners or
stock provider again. Source-cut changes retime retained captions and supporting
shots; clipped phrases are dropped for review. Narrated edits keep their audio
duration. Timeline gestures start from the current draft, so corrected captions and unlocked shots follow later cut changes.

For edits containing Pixabay, set the combined supporting-shot target, then use **Find B-roll again & render**
to search the saved speech and create one new export. Changing this target affects
only the new revision; caption-only corrections keep the saved count and footage. It includes your current hook, caption, cut
and framing changes while keeping saved narration, animations and uploaded library shots. Their occupied intervals remain reserved; only the remaining slots are searched for new stock. The original export remains
available. If no suitable replacement is found, existing supporting shots stay
in place. Render or reset manual shot changes before requesting a new search.

Auto can render the current video, checked videos, or all videos. Saved plans and
their media snapshots follow the export retention period; choose **Keep** to retain
an export and its source for further revisions. Older exports created before this feature
need a new Auto edit to gain a saved plan.

### Automatic captions in Manual

Open **Manual → Advanced (or All controls) → Captions → Caption mode**.
Choose **Automatic · avoid duplicates** to transcribe the finished soundtrack
with the free local Whisper model. Cuts, playback speed, replacement audio, and
inserted clips are already composed before transcription, so captions use the
final export clock. Choose your font and colors under **Caption appearance**.
Automatic captions are generated on export; the quick preview does not include them.
The export also includes a downloadable SRT file.

The duplicate check samples the rendered picture with local OCR. Existing or
uncertain captions are left alone, with a reason in the export notes. Choose
**Automatic · add new** to override this check. Text already baked into a source
cannot be removed or restyled. **Original captions / import SRT** keeps the existing
workflow; imported SRT and automatic captions are mutually exclusive. Settings
are per video, support **Apply to all**, and are included in Manual finishing presets.

Run `npm run setup:auto` once if the local speech model is not installed. Silent
exports and exports without usable speech receive no generated captions. Model
or transcription failures are reported instead of claiming captions were added.

### Edit with a prompt

In **Edit this result**, describe changes such as “remove the B-roll”, “make
captions smaller and move them up”, or “keep the first 20 seconds”. Choose
**Suggest edits**, review the proposed values, then **Apply to draft**. The normal
**Render this revision** button creates the corrected export. **Undo last prompt**
restores the previous draft; manual controls remain available.

Prompts support hooks, caption corrections/removal, black-band text and appearance, cut sequences, framing,
existing supporting shots, and another stock search. Output trim times refer to
the current short; explicitly requested source timestamps refer to the original.
Saved narration stays locked. Unsupported or ambiguous requests return a short
clarification without applying partial changes. Suggestions include unsaved edits
and are discarded if the draft changes while the request is running.

This uses the existing private `DEEPSEEK_API_KEY` and optional
`DEEPSEEK_TEXT_MODEL`. Each suggestion makes one bounded text request containing
the instruction, selected speech/captions and editable settings. Original video,
audio and local file paths are not sent. Proposals do not render, search stock,
or change saved exports; those actions happen through the existing render flow.

## Manual editing

Switch to **Manual** for direct control. Its saved settings are separate from Auto edits.

- Use **Edit with a prompt**, above the adjustment tabs, for the selected video: for example, “Use 01:10 to 01:35, make it a little warmer, and mute the audio” or “Portrait 9:16 at 1080p with a blurred background.” Review the exact values, then **Apply to draft**. Preview or render through the normal controls; **Undo last prompt** restores the previous settings until you make another manual change. **Apply to all** copies the reviewed settings to other sources when wanted.
- Upload multiple videos together and preview each source.
- Apply shared settings, then customize individual videos.
- Open **All controls** for the complete adjustment surface, or use the focused Essentials, Color & feel, and Advanced tabs.
- Choose from eight color looks. Looks change color and texture while preserving framing, timing, sound and text. Saved editing presets apply the wider edit settings.
- Choose from eight sound looks under **Pace & sound**: Original, Clear voice, Podcast, Warm, Bright, Noisy room, Smooth, and a deliberate Phone call effect. A sound look changes tone, noise and dynamics only, so framing, timing, volume, loudness normalization and captions stay as they are. Open **Sound modifiers** to fine-tune the seven controls behind a look — noise reduction, low cut, bass, presence, treble, level evening and de-ess — plus fade in and fade out on the finished soundtrack. Everything runs locally through ordinary FFmpeg filters; nothing is uploaded. Sound modifiers are rendered in samples and exports, not in the Live preview, and are skipped entirely when the edit is muted.
- Type exact slider values and press Enter or leave the field to apply them. Values stay within the supported range; each control has its own reset. Global reset also clears optional framing, motion, caption-style and audio-normalization settings.
- Change speed, volume, crop, zoom, aspect ratio, color, sharpening, noise, and frame blending; mirror footage and adjust timing.
- Position the subject inside cropped or zoomed footage, add a gentle push-in, normalize loudness, and adjust the size and placement of uploaded captions.
- Trim footage, add an opening text hook, burn in an uploaded SRT subtitle file, and replace or mute audio.
- Export in the source aspect ratio or 9:16, 1:1, 4:5, or 16:9, with framing, resolution, and frame-rate controls.
- Every new export strips source file and stream metadata, chapters, and software tags, including the final captioning pass. This is mandatory even for old saved settings that disabled cleanup. A final metadata check rejects unexpected tags or extra tracks before saving the export. Only neutral MP4 playback fields remain; no camera or device identity is invented. Existing exports must be re-rendered to receive this cleanup.
- File metadata cleanup does not remove visible or invisible watermarks encoded into source pixels or audio and cannot guarantee that a platform will not identify AI-generated content or limit its reach. The app does not add an AI watermark.
- Track render progress, cancel jobs, and download completed videos individually or together. Manual makes one export per video; for versions built differently, use Auto's **New angles on the same moment**. Randomized "subtle variations" (small speed, zoom and color changes) were removed: they changed how a copy looks, not what it says.

**Auto remix → Quick setup and All settings** have **Remix with a prompt**, near the top. It follows **Apply changes to → This video / Selected videos / All videos** and controls length mode, maximum versions, version differences, captions and word highlighting, black bands and their written text, stock B-roll and animation sources, shot count/coverage, uploaded footage, pacing, sound, narration and review options. For example: “Add yellow captions, black bands and append outro.mp4 in full.” Each target's changes are prepared separately and reviewed by video name before **Apply to N videos**. A clarification or failed request blocks the whole batch; matching videos need no changes.

Manual prompts support the Manual editing controls: color, texture, speed, sound modifiers, framing/layout, output size/rate, source cuts, literal titles and timed overlays, automatic or imported captions, black bands, B-roll/animation preferences, uploaded footage and replacement audio. Manual prompt changes apply to the current video; the ordinary copy-to-all controls remain available afterwards. Both editors show the complete proposal before applying and preserve unrelated settings. Changes within a workspace offer **Undo last prompt** while that prompt remains the latest edit; Auto undo also survives switching between Quick setup and All settings. Suggestions and applying them do not start exports or change future-import defaults.

If a request needs the other workspace, the proposal explicitly includes a switch: exact cuts, color or speed from Auto can prepare a Manual draft; automatic selection or narration from Manual can prepare Auto preferences. Applying that proposal opens the appropriate workspace and preserves the departing workspace's settings. Controls that cannot be combined in one workflow ask for clarification instead of applying part of the request.

Prompts use the private DeepSeek configuration, sending settings, source dimensions/duration and the names and durations of available uploaded media. Local paths, credentials and attachment IDs are excluded; uploaded files are not sent. Uploaded clips and attachments can be selected by name, with their intervals checked against the actual assets. Speech is analyzed during the normal generation/export process: specify literal title/band/overlay text, and use saved-result editing for transcript corrections. Stock searches run during export and follow the selected speech. Missing media must be uploaded first; unsupported operations return a clarification.

The **Live** preview follows the effective trim and time shift, and approximates framing and basic color. For a prompted sequence it shows the first cut; **Render 5s preview** follows the selected cuts in order, rendering the first five edited seconds through FFmpeg, including image effects, camera movement, uploaded captions, hooks and audio. Samples use up to 720p/60 fps and do not create export/history entries. Full exports remain the final check, especially for effects or audio balancing influenced by resolution or content outside the short sample.

Changing settings hides an outdated sample and cancels a preview still in progress. Only one preview renders at a time; requests time out after 60 seconds. Up to 12 samples are cached locally for 30 minutes, and restart discards the cache. Auto shows the original source until its finished export is ready.

Replacement audio loops when shorter than the rendered video and is trimmed when longer. It keeps its own playback speed; source audio follows the video's trim and speed while preserving pitch. Uploaded SRT files must be timed to the final exported video.

Time shift moves a selected trim window earlier or later within the source; it has no effect when the whole source is selected. Explicit **720p / 1080p** presets set the output's shorter edge, including upscaling when necessary; **Source** keeps native sizing. Frame blending has a memory limit, so its smoothing window can shorten on large or high-frame-rate exports.

## Long video to short clips

Choose **Short clips**, select an imported recording, and create a named short. Add one or more start/end intervals on the original video's clock. Intervals play in the order shown, so one short can join an opening, an example, and an ending from different parts of the same recording. Create more shorts from any imported source, review and approve their outlines, then render all approved drafts or an approved current/selected scope.

Timestamps accept seconds, `MM:SS.mmm`, or `HH:MM:SS.mmm`. Mark points from playback, adjust them by typing, and reorder or remove intervals before exporting. Invalid or out-of-bounds timestamps block rendering. Drafts are saved in this browser; rendered exports remain in the shared local workspace and History. Each short uses one source recording; different sources can be included in the same export batch.

The default portrait export is **1080 × 1920**, including from a 1920 × 1080 landscape recording. Use framing controls to crop around the subject or keep the full picture with background fill. A portrait crop uses only part of a landscape frame: an HD output canvas does not recover missing original detail. Five-second rendered samples use up to 720p for faster review; full exports use the selected resolution. If a browser cannot play the original codec, source timestamps and rendered samples remain usable.

**Crop zoom** creates room to reposition the frame. At 1×, a landscape-to-portrait crop already keeps the full source height, so vertical positioning is disabled until you zoom in. Position controls use 0–100% of the available travel, update the crop outline immediately, and apply to every sequence. Zoom and position are saved with the short and used by previews and exports. Choosing a full-shot background resets crop zoom.

Drag the orange crop directly on the video with a mouse or touch. The lower playback controls stay usable. With the crop focused, arrow keys move it, Shift moves farther, Home centers it, and Escape cancels an unfinished drag.

**Automatic speaker centering** optionally follows a visible face through the selected sequences. Enable it under **Frame & quality**. It runs locally using the bundled MIT-licensed YuNet detector; install its CPU dependencies once with `npm run setup:focus`. No API key or paid service is used. Each analysis seeks at most 180 small frames from the selected source intervals, without copying or decoding the entire recording. Very long selections get sparser tracking. Preview and export use the same saved source-time camera path, including reordered sequences.

This is face positioning, not audio-based active-speaker recognition. With several people visible, position the crop over the desired person before switching it on. Tracking follows the nearest face using spatial continuity; occlusion or a scene change can break that continuity. No-face or unavailable analysis keeps manual framing and shows the reason. Turning it off restores your manual position; dragging or changing a position control takes manual control. Changing source timestamps triggers a fresh bounded analysis. Review the framing before exporting.

### Edit with the transcript

**Short clips → Edit with the transcript**, under the source preview, shows the
recording's speech as text. Choose **Transcribe this video** once; the local
Whisper model runs on your computer without an API key, and the word-timed
transcript is saved with the source for Pacing and Find my best clips too. Later
visits load the saved transcript immediately. A transcription keeps running if
you select another video; **Cancel** stops it.

- Click a word to move the source playhead there. Drag across words, Shift-click,
  or use Shift+arrow keys to select. **Find words** searches the transcript,
  ignoring case and accents.
- **Add as sequence N** appends the selected speech to the current short.
  **Remove from short** takes those words out of every sequence that plays them,
  splitting a sequence when words remain on both sides. **New short from selection**
  starts a draft named after its first words. **Undo transcript edit** steps back
  through these changes.
- Words in the current short are bright, others are dimmed, and a number marks
  where each sequence starts. Words with a dotted underline had low recognition
  confidence.
- Selections keep a little of the surrounding silence without reaching the
  neighboring words; removals cut halfway into the pauses on either side.
  **Play selection** plays exactly that range and stops at its end.

The timestamp list stays the source of truth: every transcript action edits the
same sequences you can still adjust by hand. Changing sequences restarts automatic
speaker centering and invalidates earlier pacing suggestions, as a manual timestamp
edit does. Recognition can mishear words or place boundaries slightly early or
late, so listen with Play selection before rendering.

### Free cleanup and optional paid restoration

**Clean up video** applies mild local noise reduction and sharpening before resizing. It uses FFmpeg on your computer and has no API charge. It can improve noisy footage; it cannot reconstruct detail that was never captured. Compare a rendered sample before enabling it on every clip.

Paid AI restoration is a separate, optional future integration. For a first provider trial, [Topaz Precision through fal](https://fal.ai/models/topaz/upscale/video/precision) offers source-focused upscaling and noise/compression controls. As checked September 15, 2026, fal lists a one-minute 1080p/30 fps example at **$0.80**, with actual cost depending on output dimensions, duration, frame rate, and model. [SeedVR2 on fal](https://fal.ai/models/fal-ai/seedvr/upscale/video) is an alternative at **$0.001 per output megapixel-frame** (about **$3.73** for 60 seconds of 1080p at 30 fps). Confirm live pricing before adding a paid workflow.

For a future cloud integration, extract the chosen short intervals locally, enhance those clips, and add captions afterward. This avoids uploading full long recordings and keeps restoration work limited to footage you intend to export. No fal key or paid restoration call is required for the current local workflow.

## Run locally

Requirements: **Node.js 22.13 or newer**, npm, and **FFmpeg / ffprobe** on your `PATH`. Local transcription also needs **Python 3.10–3.13**. Use an FFmpeg build with `libx264`, AAC encoding, `drawtext`, and the libass `subtitles` filter.

On macOS with Homebrew:

```sh
brew install node ffmpeg-full tesseract python@3.12
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

On Debian/Ubuntu, install Node.js 22.13+ using your preferred method, then:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-dejavu-core tesseract-ocr python3 python3-venv
```

Install dependencies, prepare local transcription, and start development servers:

```sh
npm ci
npm run setup:auto
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards API requests to the backend on port 8787. Keep both processes running; `Ctrl+C` stops them.

### Windows setup

Install Node.js 22.13+ and Python 3.12, plus a Windows FFmpeg build containing
`ffmpeg.exe` and `ffprobe.exe`. Add FFmpeg's `bin` folder to your user `PATH`, then
open a new PowerShell window in the cloned repository. Check `node --version`,
`npm --version`, `py -3.12 --version`, `ffmpeg -version`, and `ffprobe -version`.
The setup scripts also recognize `python` on PATH if the `py` launcher is absent.
If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm` in the commands below.

```powershell
npm ci
npm run setup:auto
npm run setup:imports
npm run dev
```

`setup:imports` is needed for TikTok, Instagram and YouTube links. Face framing is
optional: run `npm run setup:focus` to enable it. If Python is installed in a
custom location, set `$env:PYTHON_BIN = 'C:\Path\To\Python312\python.exe'` before
running setup. Python 3.14+ is not supported by the current transcription/face
setup; the link downloader accepts Python 3.10+.

Use **browse files** or drag and drop for ordinary imports. **Link files on this
computer** uses symbolic links and can require Windows Developer Mode or additional
permissions; it now explains the upload alternative when Windows rejects a link.
Caption rendering and multi-cut exports do not require symbolic-link privileges.
Keep linked originals downloaded locally and at the same path until export finishes.

Optional local generated narration remains macOS-only. Windows keeps the original
audio. FFmpeg must include `libx264`, AAC, `drawtext`, and `subtitles`; missing
encoders or filters can still prevent export even when FFmpeg is installed.

The manual **Windows compatibility checks** GitHub Actions workflow builds the app
and exercises imports, queue recovery, SQLite, and real FFmpeg exports on Windows
with both Node 22.14.0 and the latest Node 22 release.

### Transcription models and production

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

## DeepSeek planning and optional local narration

Auto reuses `DEEPSEEK_API_KEY` from the project's existing private `.env`, also used
by prompt editing and optional AI B-roll matching. No local language-model setup is
required. The text model is `DEEPSEEK_TEXT_MODEL`, then `DEEPSEEK_MODEL` if unset,
then `deepseek-flash`. Selection, hook/callout and narration writing, editorial
checks, and repair proposals use the fixed DeepSeek API endpoint. There is no local
language-model fallback.

DeepSeek uses **low thinking effort** for complete-idea discovery, excerpt selection,
cross-section ranking, matching observed B-roll to speech, and editorial review.
Prompt edits, stock search queries, frame descriptions, hook/callout writing and
repair proposals stay in non-thinking mode. The matching decision reasons over
inspected descriptions; it cannot improve a missed observation or invent a suitable shot.
Set `DEEPSEEK_THINKING=false` in the private `.env` and restart to use fast mode
for all these decisions. Discovery caches are separate for each mode.

Thinking requests reserve up to 8,192 extra output tokens because the provider's token
limit includes reasoning. Truncation retries can increase that combined limit to
12,800 tokens. The same four-attempt maximum, 45-second per-attempt timeout and
120-second total ceiling apply; individual workflow stages can have tighter deadlines.
Only final JSON reaches schema/evidence validation and storage. Internal reasoning
is discarded. Thinking adds latency and paid output tokens; it does not guarantee
a correct answer or remove the need for review. See the
[opt-in comparison](../benchmarks/README.md#5-compare-deepseek-fast-and-thinking-modes).

These paid text requests send bounded **transcript excerpts, captions, headings,
and edit metadata** to DeepSeek. They do not upload source audio or full videos.
Transcription, rendering, and voice synthesis remain local. Optional AI B-roll
matching has its separate sampled-frame disclosure above. The backend keeps the
API key out of browser responses and exported review data.

Auto AI is enabled with `AUTO_AI=true` by default. Set `AUTO_AI=false` to disable
Auto AI planning, editorial checks, and repairs.
Without enabled AI and a usable key, Auto uses built-in candidates and
transcript-derived text; editorial judgment remains for manual review. Provider
failures also retain a usable fallback instead of granting an editorial pass.
This switch does not disable separately requested prompt edits or AI B-roll matching.

With local transcription and DeepSeek ready, **macOS** Auto edits can optionally
replace the original voice with a new scripted read using an installed `say`
voice. Enable **New narration** in the output preferences when available. A matching
voice for the transcript language is required. DeepSeek writes the script; the
installed system voice reads it locally without cloning the original speaker.
Linux and Docker retain the original audio because macOS `say` is unavailable.

## Configuration

Put your settings and API keys in a private `.env` file in the project root. The backend loads it automatically with `npm run dev` and `npm start`; explicit shell variables take precedence. `.env` is ignored by Git. See [.env.example](../.env.example) for the available settings.

| Variable             | Default                  | Purpose                                                              |
| -------------------- | ------------------------ | -------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`              | Backend listen address.                                              |
| `PORT`               | `8787`                   | Backend HTTP port.                                                   |
| `DATA_DIR`           | `data`                   | Writable directory for uploads, attachments, manifests, and renders. |
| `MAX_FILE_SIZE_MB`   | `500`                    | B-roll and legacy multipart limit in MiB; accepts 1–2048.           |
| `MAX_LARGE_FILE_SIZE_GB` | `50`                 | Resumable and linked source import limit in GiB; accepts 1–1024.     |
| `MAX_FILES`          | `100`                    | Files per selection/local-link request and maximum unfinished imports; accepts 1–100. Completed imports do not occupy queue slots. |
| `RENDER_CONCURRENCY` | `2`                      | Simultaneous processing jobs; accepts 1–4.                           |
| `RENDER_MAX_RETRIES` | `3`                      | Additional attempts after a failed/interrupted export; 0–10.         |
| `RENDER_RETRY_DELAY_SECONDS` | `5`               | Initial retry delay; 1–300 seconds, triples up to five minutes.      |
| `RETENTION_HOURS`    | `24`                     | Retention window for unkept finished jobs and unreferenced source files; accepts 1–720. |
| `WHISPER_MODEL`      | `small`                  | Local speech model; run setup for the chosen model before use.       |
| `WHISPER_CACHE_DIR`  | `DATA_DIR/models`        | Persistent speech-model cache.                                       |
| `AUTO_AI`            | `true`                   | Set exactly `false` to disable Auto AI selection, writing, checks, and repairs. |
| `DEEPSEEK_API_KEY`   | Unset                    | Existing private API key for Auto AI, prompt edits, and optional AI B-roll matching. |
| `DEEPSEEK_MODEL`     | `deepseek-flash`          | DeepSeek model for vision matching and the default text model.       |
| `DEEPSEEK_TEXT_MODEL` | `DEEPSEEK_MODEL`         | Optional text override for Auto AI, prompt edits, and B-roll search briefs. |
| `DEEPSEEK_THINKING` | `true` | Low thinking effort for editorial decisions; `false` restores fast mode. Restart after changing. |
| `PIXABAY_API_KEY`    | Unset                    | Optional free stock video search; only used for Stock B-roll.        |

For example:

```sh
RENDER_CONCURRENCY=1 RETENTION_HOURS=48 npm start
```

The queue processes two videos at once by default, including multiple Auto versions of the same source. Initial analysis and clip selection for identical source content run one at a time; after cuts are chosen, B-roll searches, editorial checks and rendering can overlap. Chosen excerpts are temporarily reserved so later versions can prefer different footage. A version that has no unused alternative waits without occupying a worker until the earlier export settles; cancelled or failed exports release their reservations. Saved revisions and manual exports can run immediately when a slot is free. Export cards explain why a job is queued, and the collection header shows processing/queued counts and capacity. Increase `RENDER_CONCURRENCY` in the private `.env` (maximum 4) and restart the backend to change capacity; additional workers use more CPU and memory.

Recoverable failures and backend interruptions retry automatically up to three times, after 5, 15 and 45 seconds by default. Waiting retries release their processing slot. The retry budget and schedule survive restarts; saved edit plans are reused when available. Export cards show the reason, interrupted stage, next retry time and exhausted retry budget. Missing media, invalid inputs, permissions, credentials and full disks require intervention. Pressing **Cancel** stops automatic retries, including after a restart. **Retry** starts a fresh retry budget. Older cancelled records lack a recorded reason and require a manual Retry; they are never silently restarted.

Sources and queue manifests are stored on disk so they survive backend restarts. In Exports, choose **Keep** to retain a finished video, its SRT, saved edit, source and referenced attachments beyond `RETENTION_HOURS`, including across restarts. **Kept** exports stay in the workspace's data directory and are skipped when clearing a collection. Turn off Keep to start a fresh retention window; a source needed by a kept export cannot be removed until Keep is turned off. Download still saves a separate copy wherever your browser chooses. Expired jobs without Keep or a saved editing draft, and unreferenced sources without short drafts, are cleaned up automatically. Speech-model weights remain cached. Large batches need enough disk space for both source and rendered files.

### App promotion copy and Postiz scheduling

**Content language defaults to English**, independently of the target country, store listing and video language. **Default content language** sets the language of the generated promotion brief. The same preference is used for post titles, short/long captions, CTA wording and descriptive hashtags. **Post language**, next to Platform, overrides it for an export without changing the app profile. App/brand names and branded hashtags stay intact. Changing the profile language automatically reloads the brief while keeping manual edits. Changing an export's Post language requires generating new copy; saved copy shows a reminder when its language differs. Original listing excerpts and the no-AI hook fallback remain untranslated and are labeled accordingly.

In **App profiles → Add app**, paste an **App Store or Google Play link**. After a short typing pause, the app automatically loads the listing and fills the brief; there is no import button to press. Country is initialized from the link when present, otherwise US, and can be changed using the country dropdown. Apple imports use the public [ID lookup API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html) plus the public listing for additional purchase details. Google Play imports read the public app page, including its full description rather than just the short search snippet. Captured facts include name, description, developer, category, icon, available screenshots (up to 40), download price and rating totals. Version, languages, update notes, age rating, downloads, ads, purchase details and developer/privacy links are retained when the store provides them. Missing fields stay unknown. Every saved listing includes its store, target country, source URL and retrieval date. A free download does not mean free subscriptions or in-app purchases.

When DeepSeek is configured, it automatically prepares the benefit, audience, features and CTA in the chosen language; this uses the configured API and can be turned off under **Import options**. Descriptive claims require supporting excerpts from the listing and retain paid-tier qualifications and limitations. A failed or unavailable AI summary falls back to original excerpts; an unstated audience can stay blank. **Review & edit app details** lets you change the brief before saving. Refreshing or changing language keeps manual edits; **Replace my edited brief on the next refresh** explicitly replaces them. Switching to a different app clears the previous app's brief. Requests are debounced and cancelled when their link changes, so an older response cannot overwrite the current app. A failed import offers **Retry loading app** without automatically retrying paid summaries.

Existing profiles and manually entered website URLs remain supported. Caption generation receives the full saved description and listing facts alongside the brief and export context. Screenshots are displayed for human review, not analyzed by the text writer. Google Play page structure can change; an unreadable or unavailable listing offers retry/manual entry instead of guessing. Snapshots older than 24 hours show a refresh reminder. Store imports do not provide live social trends or automatically refresh posts already scheduled in Postiz.

Open **Exports → Post copy & schedule** on a finished video. Save a profile for the mobile app you promote: benefit, audience, real features, call to action, store/landing URL, language and country. Profiles are reusable across exports. **Generate short & long** uses the configured DeepSeek text API and saves two editable captions, a recommendation and relevant hashtags for the selected platform. Each Copy button includes that version's hashtags. Generation runs only when requested and uses the profile plus this export's saved text; it does not inspect the finished video. Provider charges depend on actual token usage. Without DeepSeek, the hook and saved app hashtags are used as editable starting text. This recommendation is an initial hypothesis, not automatic learning from install data.

Hashtags are topical suggestions unless a recent, matching source is available. DeepSeek's training knowledge never counts as live trend evidence. The optional server setting `HASHTAG_TRENDS_URL` can point to a trusted HTTPS evidence feed. Remix adds `platform=tiktok|instagram|youtube` and `country=FR` query parameters. The feed must return an array (at most 200 records, 150 KB) shaped like this:

```json
[{"tag":"#Example","platform":"tiktok","country":"FR","sourceUrl":"https://ads.tiktok.com/creative/creativeCenter/trends","observedAt":"2026-10-05T09:00:00Z"}]
```

Only references for the chosen country/platform observed within the past 24 hours qualify; stale, future-dated and mismatched references are excluded. Selected references retain their source URL and observation date. An unavailable feed produces topical hashtags with an explicit notice. No TikTok scraping service or live feed is bundled. Check [TikTok Creative Center](https://ads.tiktok.com/creative/creativeCenter/trends) before publication; a TikTok trend is not evidence for Instagram.

To schedule posts, set `POSTIZ_API_KEY` in the ignored server `.env` and connect accounts in Postiz. Cloud defaults to `POSTIZ_API_URL=https://api.postiz.com/public/v1` and `POSTIZ_WEB_URL=https://platform.postiz.com`. For self-hosting, use the full public API base URL, usually `https://your-postiz.example/api/public/v1`, and your dashboard URL. HTTPS is required except for localhost test/self-hosted instances. Keys are never sent to the browser or included in exports. The API follows [Postiz's public API](https://docs.postiz.com/public-api/introduction).

Choose **Accounts & schedule** and check any combination of connected Instagram, TikTok and YouTube accounts, including several accounts on the same platform (up to 50 per batch). Accounts are grouped by platform, with select-all controls and disconnected accounts disabled. The **Caption for** dropdown in the copy step chooses the writing context; it does not restrict scheduling targets. Each platform starts with the current caption and has its own editable title, caption/hashtags and applicable visibility, disclosure or audience settings. All selected accounts on that platform use this reviewed version.

Choose a shared date at least two minutes ahead and an IANA time zone. Ambiguous daylight-saving times require choosing the occurrence; skipped local times cannot be scheduled. Review the video and account selection, then click **Schedule to N accounts**. The server uploads the MP4 once and creates a separate, durable post for each account. An account failure does not stop the other accounts; results show which were confirmed and which need attention. Retrying sends only remaining accounts, and unchanged confirmed or unconfirmed posts are not resent. Each post can be refreshed or cancelled independently under **Scheduled posts**. TikTok uses direct posting, not the inbox upload workflow; Instagram uses a single-video Reel. Postiz performs the later publication, so Remix Studio can close after confirmation. The export is automatically kept and protected during upload.

**App profiles & scheduled posts** lists the durable scheduling history, even after local media expires. Refresh status to reconcile with Postiz, cancel a future post, or open its published link. Confirmed publications also appear in the existing export History. The app does not silently retry post creation: identical scheduling requests reuse the same record, and a lost response blocks another attempt until its status is checked. An interrupted upload can be tried again; interrupted post creation is marked unconfirmed. Actual posting still depends on the connected account, Postiz service and each platform's requirements.

This is a private tool with **no user authentication**. Keep the default loopback binding or run it behind your own authenticated access layer.

## Docker

The image includes Node.js, FFmpeg, Chromium for HyperFrames and Remotion cards, fonts, Python, and the isolated transcription dependencies. It runs the production app as a non-root user. Models are downloaded into the persistent data volume after the image is built.

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
# Use your existing private .env; set HOST=0.0.0.0 and DATA_DIR=/app/data for Docker.
# For a different WHISPER_MODEL, run the setup command with that same env file first.
docker run --rm --name remix-studio \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  -v remix-data:/app/data \
  remix-studio
```

For DeepSeek planning in Docker, pass the existing private `.env` with
`--env-file .env` as above. macOS narration is available when running the app
directly on macOS, not inside Docker.

## Development and checks

```sh
npm run typecheck
npm run build
npm test
```

`npm test` preloads `tests/setup.mjs` before application imports, giving each test process a temporary workspace and clearing personal provider keys. To run one test with the same isolation, use `node --import ./tests/setup.mjs --import tsx --test tests/export-recovery.test.ts`. Tests that choose their own fixture directory must set `DATA_DIR` before importing server modules; the store rejects a mismatch.

FFmpeg and ffprobe must be installed for media integration tests. Local transcription tests use the cached speech model when present; the spoken fixture uses macOS `say`. Tests skip those optional checks when their prerequisites are absent and never download weights.

The app runs locally on your Mac. GitHub Actions provides optional remote verification:

- Pushes to `main` run only the build and type checks, without installing media tools or running the test suite. Documentation-only pushes are skipped. New pushes cancel superseded automatic checks.
- Full remote tests run only when you explicitly choose **Actions → Build checks and manual tests → Run workflow**, or run `gh workflow run ci.yml --ref main`. A push does not cancel a manually requested test run.
- Run `npm test` on your Mac for local testing without using GitHub Actions minutes.

The frontend uses React, TypeScript, and Vite. The Express API validates uploads, persists sources and jobs, and runs FFmpeg in a background queue. No browser extension or platform account connection is required.

## Troubleshooting

- **Missing FFmpeg:** confirm `ffmpeg -version` and `ffprobe -version` work in the same shell that starts the app, then restart it.
- **Render failed:** inspect the error shown on the job. Confirm the input is a playable video and any uploaded subtitles use SRT format.
- **Speech editing unavailable:** run `npm run setup:auto` with the same `WHISPER_MODEL` and cache path used to start the app. Allow a few seconds for capability checks to refresh.
- **No Auto captions:** the source may contain no detectable speech. Check the export notes; a visual fallback still produces an edit.
- **Planning unavailable:** confirm the backend loads `DEEPSEEK_API_KEY`, `AUTO_AI` is not `false`, and the configured DeepSeek text model is available. Restart after changing `.env`. Auto continues with built-in selection; unavailable editorial checks require manual review.
- **Narration unavailable:** run directly on macOS with an installed voice for the source language; the export notes describe any narration fallback.
- **Text or subtitles fail:** check your FFmpeg build includes `drawtext` and `subtitles`, and install a system font. The Docker image includes these dependencies.
- **Slow exports:** reduce resolution, frame rate, or render concurrency. Encoding speed depends on clip duration, effects, and available CPU.
- **Uploads rejected:** check the per-file size and batch limits in your configuration.
- **Linked original reported as moved or changed on Windows:** update the app, restart it, remove the failed import card and link the original again. Linked-file checks now resolve the original path before comparing metadata, avoiding inconsistent Windows volume IDs through symbolic links. If the file really moved or changed, re-import it from its current location. You can also use **browse files** or drag and drop to upload a separate copy.

### Workspace storage and migration

Workspace records are stored in `data/remixer.sqlite` (or `DATA_DIR/remixer.sqlite`).
SQLite runs inside Node, with no account or database server. Sources, jobs, attachments,
B-roll and history each have individual rows. Routine saves update only changed rows;
history is read on demand and publication updates write only the affected history record.

On first startup the app imports `state.json` in one transaction, leaves the original
untouched, and creates `state.json.pre-sqlite.bak`. Invalid data stops startup instead
of silently creating an empty workspace. Once migration succeeds, SQLite is authoritative;
editing the old JSON does not change the workspace. Both legacy files may be kept as
migration backups, but they do not contain later edits.

For a current backup, stop the app first and copy the data directory, or use SQLite's
online backup command (`sqlite3 data/remixer.sqlite '.backup data/remixer-backup.sqlite'`).
Do not copy only a live database file: committed changes may still be in its `-wal`
sidecar. Videos and retained previews are separate files and need their own backup.
Use one running app per workspace; a synced folder is not a multi-computer database server.

Maintenance runs at startup and every 15 minutes. It removes expired stock API
search caches after 24 hours, semantic search briefs after 7 days, and cached
B-roll descriptions after 30 days. Abandoned render work directories become eligible
after 48 hours; directories belonging to retained jobs stay protected. Each pass
removes at most 500 items. Symlinks are skipped. This cleanup never scans publication
records, migration backups, uploaded B-roll, model weights, or history previews.
Existing source/export expiry still follows `RETENTION_HOURS`; this feature does
not shorten that period.

### Export history

History records completed exports independently of temporary video files: source
content fingerprint, original source excerpts, saved title, B-roll IDs and intervals,
and publication notes. Reimporting identical bytes under a new filename or batch
reveals earlier exports. Auto prefers unused excerpts, but history similarity is
advisory: it can reuse an excerpt and render again with your current B-roll and
settings. Explicit edits of a saved result remain available as revisions. A
different encoding has a different exact fingerprint; sampled picture matching can still identify it as a possible re-export.
Available older exports are migrated when the server starts; sources already removed
before this feature cannot be reconstructed. Deleting a batch or automatic media
expiry keeps the history. Publication dates and links are local records of posts you
have already published; the app does not post them.

History loads 50 exports per page. Search covers the entire ledger, including older
pages, and shot reuse counts include all exports. Settings comparisons and individual
post observations show the current page; the all-history review comparison loads when
opened. Full measurement downloads still include every record.

History cards retain a small preview frame from each completed export in
`data/history-thumbnails`, separately from video retention. Click the frame to
play an available video, or open the saved image after its video expires. Startup
also fills missing previews for older entries: it uses the export when available,
or the recorded excerpt from a matching source, labeled **Source frame**. If both
are gone, the card shows **Preview unavailable**. Preview creation uses local
FFmpeg and does not call an AI service.

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

In **History → Record review & results**, give each whole short a verdict:
**Accept unchanged**, **Accept after correction**, or **Reject**. You can record
acceptance without rendering a revision. Optional issue categories identify
problems with the opening, ending, meaning, heading, captions, framing, or B-roll.
Comparisons show explicit verdict counts, acceptance without changes, overall
acceptance, and the number of undecided exports. Only recorded verdicts enter the
acceptance-rate denominator; a technical pass is never counted as human approval.
Each export/revision is counted separately. Median correction time accompanies
the existing average; missing times remain unknown, and an explicit zero counts.

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
diagnostics and read [the benchmark guide](../benchmarks/README.md) to evaluate owned
or licensed speech examples with the same review rubric. Synthetic technical
fixtures do not substitute for reviewing real speech, stock relevance, or actual
post performance.

### Pexels and adding stock after export

Select **Pexels**, **Pixabay**, or both under Supporting visuals. Pexels uses
`PEXELS_API_KEY` in the real private `.env`; restart the backend after adding a key.
Pexels searches existing videos and uses the same motion, framing, relevance and
bounded download checks as Pixabay. Searches are cached for 24 hours. Provider
failures do not prevent another selected provider from being tried. Animation-only
filtering is available on Pixabay. Source pages, creator names and license links
are retained with each stock asset. [Videos provided by Pexels](https://www.pexels.com).

In **Edit this result**, “add 2 more B-rolls” requests two additional stock shots
while retaining existing placements. “Find B-roll again” replaces stock choices
while preserving saved cards and uploaded library shots. Both searches happen
when rendering the reviewed revision. An edit originally made without stock can
also request it. Follow-up prompts retain the pending shot count; undo restores
it along with the prior draft. The current limit is ten supporting shots total.

### Find my best clips

In **Short clips → Find my best clips**, enter an optional editorial brief, a maximum of 1–20 suggestions, and minimum/maximum whole-second lengths. Discovery transcribes locally and reviews the transcript section by section with the configured DeepSeek account. It works with existing shorts and long recordings. Successful sections are cached by transcript, model, brief and length range; cancelled or interrupted requests can reuse them on retry. Semantic review has a 15-minute budget and reports partial coverage explicitly.

Preview suggestions, inspect their speech and neighboring context, dismiss them, or **Keep clip / Keep all visible** to create ordinary editable timestamp drafts. Nothing renders until you use the normal render controls. **Find other moments** excludes the current suggestion set; export history never blocks discovery. Counts are best effort, and clips keep original speech rather than generating quotations. This speech-based feature requires the local transcription model and configured DeepSeek; silent footage can still be cut manually.

### Batch draft review

Kept suggestions retain their summary in **Your short clips**. Each draft has editable summary and contribution notes, exact source timestamps with preview links, and previous-export/publication matches. Notes describe your intended edit; they do not generate narration or overlays. History matching compares overlapping intervals from the same source fingerprint, including reimports, and distinguishes recorded publications from exports. It cannot check posts outside the workspace. A missing source, missing fingerprint, or failed lookup is shown as unavailable rather than a clean history.

Use **Approve draft** or select several drafts and **Approve selected** before rendering. **All approved drafts** is the default render scope. Other scopes require every included draft to be approved. Content or finishing changes invalidate approval; derived face tracking does not. Draft notes and approvals survive browser reload, and rendered shorts retain the notes and an editable plan for later revisions.

**Exports → Review flagged moments** groups existing picture/sound findings across finished videos. Open a timestamp, then **Edit this moment**. When a finding maps unambiguously to a saved supporting visual or uploaded placement, **Remove shot** stages its removal and **Replace shot** opens its replacement controls. Render the revision to apply your choices; the original export remains available. Ambiguous or caption-only findings stay available for manual review. No post-render shot removal happens automatically.

### Free active-speaker framing and layouts

Short clips now offers **Tracking method → Follow active speaker · Free, local AI** under automatic centering. Install once with `npm run setup:speaker` (PyTorch CPU dependencies and a checksum-verified 63 MB TalkNet model). Subsequent analysis runs locally without a service account, key, or API fee. Select the person manually for **Follow selected face**, or use active-speaker mode to compare synchronized audio and face motion. The latter supports up to 10 minutes of selected footage per short and can take longer than playback on a CPU.

Speaker changes require a sustained lead and a minimum shot hold; silence and ambiguous overlapping/offscreen speech retain a visible/manual frame. Multiple faces, occlusion, small faces and edited audio can reduce accuracy. Partial/unavailable results remain visible, manual framing stays available, and dragging the crop disables automatic tracking. Source-time tracks are cached separately for the two tracking modes and used by previews and exports.

**Layout** includes Single frame, Two people · stacked, and Full scene + speaker. Stacked layouts expose separate subject positions; the scene layout keeps the complete source above a speaker close-up. These use regions of the same original recording, not invented camera angles. A five-second rendered preview shows the actual composition. Full-shot contain/blur options remain available in Single frame. Switching layouts disables old automatic tracking until you choose it again.

Local architecture attribution: [Sieve fast-asd / TalkNet](https://github.com/sieve-community/fast-asd), MIT license retained in `scripts/vendor/talknet/LICENSE`. The Sieve cloud application is not used.

### Named finishing presets

Open **Finishing presets** in Auto remix, Manual, or the Short clips editor to name and save the current finish. Each mode has its own preset collection. Auto presets include aspect ratio, existing-caption handling, stock/animation sources, requested shot count, and matching preferences. Manual presets include framing, color, audio level and caption style. Short presets include format, layout, face/speaker tracking method, normalization and cleanup; they can also be applied to checked shorts together.

Applying a preset preserves each target's footage, timestamps, playback speed, hook text, captions, attachments and manually chosen subject positions. Source-specific media IDs and credentials are never stored in presets. Automatic framing for a batch of short drafts is prepared before those exports are queued. Older manual presets migrate to the new selector with source-specific fields removed. Up to 60 named presets are saved locally in this browser; storage failures are shown. The existing Apply to all controls can copy applied preferences to other videos when wanted.

### Pacing with review and undo

Auto remix offers **Original**, **Natural**, **Tight**, and **Custom** pacing. Natural shortens internal pauses longer than 0.9 seconds while leaving 0.35 seconds; Tight uses 0.6/0.22 seconds. Custom accepts a 0.4–5 second threshold and 0.12–1 second retained pause. The selected opening and ending stay intact. These preferences are included in Auto finishing presets. Older queued jobs without a pacing preference retain their previous behavior.

In **Short clips → Refine the pacing**, analyze locally, listen around each suggested trim, uncheck anything to keep, then apply. The original sequences and review choices survive browser reload, and **Undo pacing changes** restores those sequences. Changing timestamps invalidates an old review. This uses the existing local speech model and cached transcript; it makes no paid API request.

Filler removal is off by default. When enabled, it only proposes isolated, high-confidence “um”, “uh”, “erm” (English), “euh” (French), or “äh”/“ähm” (German). Meaningful words and repeated phrases are retained. Unreliable or missing word timings leave that sequence untouched. Transcription can still miss speech: preview suggested edits before exporting. Trims respect the 60-sequence limit. Very short audio fades soften joins without shortening the export or moving caption timing.

### Export settings, posting outcomes and picture history

Each new History entry keeps an immutable settings snapshot and a profile ID, plus
actual caption mode, supporting-shot count and coverage. **Settings & posting
outcomes** groups comparable settings. Record TikTok, Instagram or YouTube posts
with their account, URL and publication date, then attach dated results and notes
to that particular post. Reach can be unknown, normal, suspected restriction,
confirmed restriction (with the platform notice), or resolved. Low views alone do
not establish a restriction, and the comparison describes associations rather than
proving that a setting caused an outcome. JSON/CSV measurement exports retain these
records. Earlier entries without saved settings remain explicitly unknown.

History also retains small, local picture signatures for original sources and
finished exports. Six independently sought frames can recognize likely re-encodes,
resizes and centered portrait crops of similar duration; static/blank or
insufficient samples are not treated as identity evidence. These are **possible
picture matches**, with previews to compare. They do not map a re-export's clock
onto an older source or reserve/exclude clips. Exact-source overlap warnings also
catch shorter excerpts inside an earlier cut. Every history match is advisory.
Heavy rearrangement, arbitrary crops and overlays can prevent recognition. Retained
signatures survive media expiry; an old file that is already gone cannot be newly
inspected.

### Place your own footage

Added clips belong to the video where you place them. General settings copies
and future-import defaults do not copy these placements. Use **Apply footage to
selected videos** to copy them explicitly. Legacy placements saved without a
source binding are cleared from workspace preferences and excluded by the export
API; uploaded files and existing exports remain available.

Active clips from **Add my own footage** are listed beside the main preview,
with their filename and intro, outro, insert or cover timing. **Live** plays the
source and added clips together on one scrubber, including the added duration.
**Watch in edit** and the clip buttons below the player jump to each placement.
Changing a placement or its framing jumps to that clip so the change is visible.
Inserted clips use their selected trim, audio and crop/contain setting; covers
retain source audio. Manual preview follows the source cuts and speed; Auto
preview uses the full source until Auto chooses its final cuts during remixing.
Generated captions, watermark cleanup and final sound effects still require
a rendered sample or export. **Original** plays the unchanged source.
**Remove** there removes only that placement
from the current video, regardless of the batch settings scope. Source cards and
the render bar include added clips in their summaries; turning off automatic
supporting shots does not remove explicit footage placements.

Open **Your footage** in Auto, Manual, Short clips, or Edit this result. Upload a
video, then either append it automatically or place a selected part:

- **Add the whole clip at the end** uses the entire uploaded clip after the final
  edit. Placement mode and all three timing fields are hidden. Each export finds
  its own ending automatically, including after cuts or speed changes. Multiple
  appended clips play in their listed order. Audio and framing remain adjustable.

- **Insert** adds a segment and lengthens the export. Use the clip's audio or mute
  that inserted segment. Original captions and later shots move around the insert.
- **Cover** replaces the picture while the original soundtrack continues. Your
  cover takes priority over an automatic supporting shot at that time.

Choose crop or contain framing for each placement. In Auto Quick setup and All
settings, footage controls follow **Apply changes to** and replace the target
videos' placements while preserving other settings. **Apply footage to N selected
videos** explicitly copies the displayed placements to checked videos. General
**Copy all Auto settings** preserves each video's footage. In Manual, footage
controls affect the current video. In Short clips,
the footage panel can copy placements to every short. An insert beyond the edit's
end is appended with a note; a cover beyond its end is omitted with a note. Assets
used by a saved edit are retained for revisions even if removed from the library.

Auto's **Maximum B-roll coverage** limits the combined stock, library and animation
coverage throughout every best-effort pass. The default is 60%; 0% requests none.
Shot count is a target, subject to the coverage budget and available good matches.
Explicitly placed personal footage is controlled separately by your timestamps.

### Review the finished picture and sound

**Review finished picture & sound** is on by default in Auto (and runs for manual
exports). Auto has a per-video switch. The report remains separate from both the
transcript-based editorial review and technical FFmpeg checks:

- Up to 12 output frames are compared with corresponding source pictures. Checks
  look for a replacement hiding a demonstration, misleading use of illustrative
  stock, and visibly cropped or conflicting text.
- Local Whisper transcribes the actual exported soundtrack. Confident timed words
  are compared with authored captions, or clear subtitle text read from sampled
  frames when no caption sidecar exists. Missing or weak evidence is reported as
  unavailable, never silently counted as a successful check.
- Audio up to 180 seconds is transcribed in full; longer videos sample three
  20-second windows. Picture review always uses samples and can miss problems
  between them. Reports show exact coverage and timestamped findings.

Click a finding's time to preview it. **Recheck picture & sound** reviews the
existing MP4 without rerendering; unchanged rendered-audio evidence is cached.
Reports and their service-failure reasons are saved with export history. Findings,
partial checks and unavailable services never prevent downloading the export.

Picture inspection sends sampled source/output JPEGs and recognized speech to
DeepSeek; audio transcription stays local. `DEEPSEEK_VISION_MODEL` defaults to
`deepseek-flash`, independently of the text model. See the provider's
[vision API documentation](https://api-docs.deepseek.com/guides/vision/).
`AUTO_AI=false` disables this review. The review has a bounded processing budget
and does not automatically alter the rendered video or predict platform eligibility.

### Share an error report

Errors across imports, previews, editing tools and exports now show a recovery
step and **Copy error details**. Ask someone experiencing a problem to copy that
report and send it to you. If clipboard permission is blocked, the app provides
selectable text to copy manually. Error notifications remain until dismissed.

**Help & errors** keeps the latest 30 action reports for the current browser
tab, including after a refresh. Users can review reports, copy recent details, or
clear the history. Nothing is sent automatically. Intentional cancellation does
not create an error report. Automatic health, capabilities, library, job and import
list checks retry quietly: their network, proxy and response errors do not create
popups or history entries. A reconnecting status clears when the connection returns.
Previously saved entries from these checks and their old startup notifications are
removed when the app loads. Failed user actions, including imports and exports
during an outage, still retain their reports.

Reports include a reference, time, action, error code, relevant HTTP status,
frontend/server revisions, browser and operating system, and available server
code locations. API responses carry `X-Request-ID`; unexpected server exceptions,
streaming failures, and import/export failures log their reference in the app
terminal. Failed import/export diagnostics are saved with their existing records.
Local paths, remote URLs, email addresses and common credential formats are
redacted. Reports do not attach files, request bodies or environment variables;
users should still review the error text before sharing it.

If file selection appears to stall before uploading, the import panel shows
whether it is **Reading video file** or **Waiting for the server**. Each preparation
step has a 30-second deadline and a **Stop preparing** button. A timeout ends the
remaining batch preparation; already queued files can continue. A readable file
starts uploading as soon as its import is created. File reads only sample up to
128 KiB for resume identity, including for large videos.

The copied report distinguishes `FILE_READ_TIMEOUT` / `FILE_READ_FAILED` from
`IMPORT_QUEUE_TIMEOUT`. For file-read errors, check that the video opens locally
and try a copy in another local folder. For server confirmation errors, check the
app terminal and refresh the queue before retrying: the server may already have
created that import. Selecting the same unchanged file resumes a listed upload.
Empty, oversized and unsupported files fail before reading with
`EMPTY_VIDEO_FILE`, `LIMIT_EXCEEDED` or `UNSUPPORTED_VIDEO_FORMAT` (the message
names the extension). When one file fails, the error notification copies that
file's own report; when several fail, it lists each file with its code.


### Faster export editing and review

- Turn on **Highlight each word as it’s spoken** in caption appearance. The selected word changes color in the exported video and draft preview. Saved speech timings are used when the words match; uploaded SRTs and rewritten wording use estimated timings. The four caption looks keep their existing appearance when highlighting is off.
- Export cards show a retained thumbnail, a muted preview on hover or keyboard focus, and a short title that can be renamed. One status summarizes the available checks: **Ready**, **Review needed**, or **Problem**. Open **Details & checks** for the individual reports, source filename, credits and notes.
- **Help & errors** records action failures rather than adding old editorial reports when History opens. Saved findings remain available with each export.
- **Edit this result** opens a montage workspace: **Live edit** plays the draft across cuts and uploaded clips; **Compare saved export** plays the previous render separately. Framing, captions, prompts and review notes are in collapsible sections. **Render new revision** saves a new export and preserves the original. The live view previews cuts, text and supporting picture; final sound processing, transitions and effects require rendering.
- The **Timeline** uses the complete movie clock, including inserted clips and full-length outros. Click or scrub the ruler to seek. Drag video clips to reorder them, use their edge handles to trim, or Shift-click a sequence of clips. Copy/paste inserts at the playhead and moves following clips; the destination clip is split when needed. **Import clip**, or dropping video files onto the Video track, inserts footage at that point. Saved B-roll can be dragged onto the supporting track. Source audio has its own waveform. Undo/redo retains up to 100 draft states.
- **Shortcuts** in the timeline lists the supported [Final Cut Pro conventions](https://support.apple.com/guide/final-cut-pro/keyboard-shortcuts-ver90ba5929/mac): `A` Select, `B` Blade, `⌘B` split, `⌘C/X/V` copy/cut/insert clips, Delete to remove and close the gap, `⌘Z` / `⇧⌘Z` undo/redo, Space play/pause, `J/K/L` reverse/pause/forward (repeat J or L for 2× and 4×), arrows for one frame, Shift-arrows for ten frames, up/down for adjacent cuts, `N` snapping, `⇧Z` fit and `⌘+/-` zoom. On Windows/Linux, the toolbar and shortcut guide display `Ctrl+B`, `Ctrl+C/X/V`, `Ctrl+Z`, `Ctrl+Y` (or `Ctrl+Shift+Z`) and `Ctrl+click` automatically; Mac displays the Command equivalents. `Ctrl+A` / `⌘A` select all clips, and `Ctrl+Enter` / `⌘Enter` toggle the focused clip in the selection. Drag/drop and edge trimming work on both platforms. Text fields retain their normal shortcuts; Alt/AltGr combinations and IME composition are left to the operating system. At least one main-source clip must remain; saved narration still requires an unchanged main duration.
- **Exports → Quick review** opens a full-window portrait player. Use **A** to accept, **E** to edit and **R** to reject, or the visible buttons. Left/right arrows move through the collection. Notes and explicit decisions are saved in History and included in its acceptance statistics. Advancing or letting a video end does not imply acceptance; rejected files are retained. Typing in notes never triggers the shortcuts.
