# Desktop app

The [desktop preview](https://github.com/best-trading-indicator-tools/video-remix/releases/tag/v1.1.0-preview.1) wraps the existing editor in an isolated Electron window. It includes Node, SQLite, FFmpeg, FFprobe and a managed Python installer. Optional features are downloaded from **Local tools**, with progress, cancellation and retry. There are no app API keys required for local editing or local AI upscaling.

Supported build targets are Apple Silicon / macOS 14+, Windows x64, and Linux x64. The current public preview is unsigned and is not Apple-notarized; OS protections may prevent it from opening. Do not disable protections. Source installation remains available while distribution signing is being prepared. Linux also needs the usual graphical desktop libraries; AppImage may need FUSE, with `.deb` provided as an alternative.

## Your data

The app creates its own workspace, separate from a source checkout:

- macOS: `~/Library/Application Support/video-remix/`
- Windows: `%APPDATA%/video-remix/`
- Linux: `~/.config/video-remix/`

`workspace/` contains the database, footage, exports and encrypted API settings. `engine/` contains managed Python environments, model files, renderer downloads and installation markers. Updating the app preserves this directory. First-time model installation can download several GB; video storage needs additional space. The Downloader remains a free standalone utility, separate from the editing workflow.

The desktop window currently owns access to its private engine. The external Claude/Codex MCP workflow still uses a source/self-hosted installation; it does not attach to this desktop process.

The UI uses a private localhost port chosen on first launch and retained for browser drafts, with a new per-launch token. Renderer Node access is disabled, context isolation and sandboxing are enabled, and only explicit setup commands are exposed through the preload bridge. External HTTPS links open in your normal browser.

## Build and verify

```sh
npm ci
npm run desktop:pack   # unpacked app for testing
npm run desktop:build  # installer for the current supported OS / architecture
```

`desktop/build-resources.mjs` verifies pinned checksums for FFmpeg, matching FFprobe and uv. It checks required filters and includes upstream licenses and source locations. Dependencies and models installed later use the same setup scripts as source installations, in a writable app-owned directory. No developer `.env`, media workspace or predownloaded model weights are packaged.

`.github/workflows/desktop.yml` builds all three platforms. Its smoke test starts the **packaged** Node engine in an empty workspace, verifies localhost token protection, imports a generated video, renders text, checks audio/video output and shuts down cleanly. This catches missing binaries, resource paths and runtime dependencies; it does not certify every OS desktop or GPU driver. Upscaler inference has a separate compatibility workflow.

The local Mac verification also exercises the native first-launch installer, API Settings and a real AI-upscaled central preview. Source tests cover API errors/no-credit/timeouts, unsaved-key checks, cancellation, private runtime preparation, and real FFmpeg preview rendering and metadata cleanup.

Installer artifacts are available on successful Actions runs for 14 days. Public preview assets are attached to the release. There is no automatic app updater yet; download and replace the app for updates. Publishing stable installers additionally requires Apple Developer ID signing + notarization and Windows code signing; CI deliberately uses unsigned builds until those credentials are configured.
