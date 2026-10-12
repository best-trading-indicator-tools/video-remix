# Desktop app

The [desktop preview](https://github.com/best-trading-indicator-tools/video-remix/releases) wraps the existing editor in an isolated Electron window. It includes Node, SQLite, FFmpeg, FFprobe and a managed Python installer. Optional features are downloaded from **Local tools**, with progress, cancellation and retry. There are no app API keys required for local editing or local AI upscaling.

Supported build targets are Apple Silicon / macOS 14+, Windows x64, and Linux x64. The current public preview is unsigned and is not Apple-notarized; OS protections may prevent it from opening. Do not disable protections. Source installation remains available while distribution signing is being prepared. Linux also needs the usual graphical desktop libraries; AppImage may need FUSE, with `.deb` provided as an alternative.

## Your data

The app creates its own workspace, separate from a source checkout:

- macOS: `~/Library/Application Support/video-remix/`
- Windows: `%APPDATA%/video-remix/`
- Linux: `~/.config/video-remix/`

`workspace/` contains the database, footage, exports and encrypted API settings. `engine/` contains managed Python environments, model files, renderer downloads and installation markers. Updating the app preserves this directory. First-time model installation can download several GB; video storage needs additional space. The Downloader remains a free standalone utility, separate from the editing workflow.

On macOS, use **Browse files** for protected folders. If linking an absolute path times out, import it through the file picker instead so the app receives access to the selected file.

The desktop window currently owns access to its private engine. The external Claude/Codex MCP workflow still uses a source/self-hosted installation; it does not attach to this desktop process.

The UI uses a private localhost port chosen on first launch and retained for browser drafts, with a new per-launch token. Renderer Node access is disabled, context isolation and sandboxing are enabled, and only explicit setup and update-check commands are exposed through the preload bridge. External HTTPS links open in your normal browser.

## Updates

The packaged app checks the public GitHub releases feed on launch and every six hours. **Settings → App updates → Check for updates** checks on demand. Checks use no API key and send no footage, workspace settings or credentials. Offline checks leave editing available and can be retried.

A newer compatible release shows a dismissible **View update** notice. It opens the official release page in your browser. Download the installer for your computer, finish your current work, quit Remix Studio, and replace the app. Your private workspace and installed models remain in the data directory above. Nothing downloads, installs or restarts automatically. The original `v1.1.0-preview.1` has no update checker; download a newer preview once to gain it.

Preview versions receive newer previews and stable releases; stable versions receive only stable releases. Drafts, incomplete uploads, older versions and releases without an installer for this computer are ignored.

## Build and verify

```sh
npm ci
npm run desktop:pack   # unpacked app for testing
npm run desktop:build  # installer for the current supported OS / architecture
```

`desktop/build-resources.mjs` verifies pinned checksums for FFmpeg, matching FFprobe and uv. It checks required filters and includes upstream licenses and source locations. Dependencies and models installed later use the same setup scripts as source installations, in a writable app-owned directory. No developer `.env`, media workspace or downloaded large AI weights are packaged. The small tracked YuNet face model and its license are included.

The manually dispatched `.github/workflows/desktop.yml` builds all three platforms. Its smoke test starts the **packaged** Node engine in an empty workspace, verifies localhost token protection, imports a generated video, renders text, checks audio/video output and shuts down cleanly. This catches missing binaries, resource paths and runtime dependencies; it does not certify every OS desktop or GPU driver. Upscaler inference has a separate compatibility workflow.

The local Mac verification also exercises the native first-launch installer, API Settings and a real AI-upscaled central preview. Source tests cover API errors/no-credit/timeouts, unsaved-key checks, cancellation, private runtime preparation, and real FFmpeg preview rendering and metadata cleanup.

Installer artifacts are available on successful Actions runs for 14 days. Public preview assets are attached to the release. Publishing stable installers additionally requires Apple Developer ID signing + notarization and Windows code signing; CI deliberately uses unsigned builds until those credentials are configured.

## Requested desktop builds and releases

Normal pushes run build/type checks. Desktop packaging and publication require an explicit user request, as recorded in [AGENTS.md](../AGENTS.md). Completing a feature or changing `desktop/release.json` never starts an installer build. Changes accumulate until the next requested build or release.

For a requested installer build without publication, run the **Desktop builds and releases** workflow on `main` with `publish` left off. No release version change is needed:

```sh
gh workflow run desktop.yml --ref main -f publish=false
```

When a desktop release is requested, first prepare a version newer than `package.json` and concrete release notes:

```sh
npm run desktop:release -- <new-version> "Describe the completed feature" "Describe bundled improvements"
```

Commit `package.json`, `package-lock.json` and `desktop/release.json` together with any pending changes, then push directly to `main`. Explicitly start publication with:

```sh
gh workflow run desktop.yml --ref main -f publish=true
```

The workflow builds the commit selected by that dispatch on Mac, Windows and Linux and checks each packaged engine. Only when all three succeed does it create a draft, upload all five installers plus SHA-256 checksums, verify GitHub's asset digests, and publish the release. The `publish` option defaults to false; the version file and a push alone do not authorize publication.

If a release build or upload fails, no new public release appears. Rerun the failed workflow for transient failures; if a code fix is needed, prepare a higher version. A published version's files are never replaced. Separate requested builds do not cancel one another.
