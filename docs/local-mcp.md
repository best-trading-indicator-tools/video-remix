# Local MCP

The `remix-studio` MCP server connects Claude or Codex to Remix Studio on this
computer. The client launches a small stdio process that calls the existing
loopback API. The app continues to handle imports, rendering, provider keys,
billing information and exports. No public server or separate API deployment is
required.

## Setup

From the repository folder:

```sh
npm install
npm run build
npm run mcp:install
```

The installer registers `remix-studio` in installed Codex, Claude Code and Claude
Desktop clients. It uses absolute Node and launcher paths so GUI clients can
start it without your terminal's working directory or PATH. Existing settings
are preserved, and each changed configuration gets a private, timestamped
`.before-remix-mcp-….bak` backup. An existing, different server with the same name
is preserved and reported as a conflict.

Keep the app running with `npm run dev`, or `npm start` after building. Restart
Claude Desktop; open a new Claude Code or Codex session to load the connection.
Ask the client to check Remix Studio's status. The default backend is
`http://127.0.0.1:8787`. The launcher reads this repository's `.env`; `PORT` changes
the default port, and `REMIX_API_URL` can select another HTTP loopback origin.
Remote addresses and redirects are rejected.

For a client not covered by the installer, add a stdio MCP server with the
absolute Node executable as `command` and the absolute path to
`scripts/mcp.mjs` as its sole argument. `node -p process.execPath` prints the Node
path. If you move the repository or remove that Node installation, update the
client entry. Run `npm run build` after changing MCP code, then restart clients.

## Example requests

- “List my Remix Studio videos and available ending clips.”
- “Create an Auto draft for video A and video B. Keep both full length and their
  original audio. Append outro.mp4 to both.”
- “On both videos, add black bands and put BPC157 in medium white Cyrillic text
  in the upper band. Keep the lower band text unchanged.”
- “Make these two videos vertical, show me the draft, and export both.”
- “Check the exports and give me the MP4 download links.”
- “Show the DeepSeek usage for these exports and my remaining account balance.”

The client first discovers the current video and footage IDs, then creates and
updates a draft. Bulk changes apply to every video in that draft unless specific
source IDs select a subset. Each video's other settings stay intact. Adding an
ending preserves earlier footage placements; setting `ownFootage` directly
replaces its entire list. To import a file through chat, provide its absolute
local path. Main videos and ending/B-roll assets have separate import tools.

## Drafts and rendering

MCP drafts are separate from the app's browser selections and unsaved settings.
They are shared across local Claude and Codex sessions through SQLite in
`DATA_DIR/mcp` (or `data/mcp` by default). `REMIX_MCP_DATA_DIR` overrides that
directory. Each API origin has its own draft file. The server uses revision
checks to prevent one client from overwriting another client's edits.

New Auto drafts keep the complete source, its original framing and audio, and
make one export per video. Added speech captions, stock visuals, narration,
pacing and editorial reviews start off. Bands and band text can still be added.
Choose `durationMode: "excerpt"` explicitly for shorter clips, multiple versions
or narration. Manual drafts support cuts, speed, color and the normal Manual
settings. Quick setup and All settings are browser views of the same Auto
options; the MCP exposes those options directly.

Claude or Codex can translate an ordinary request directly into typed draft
updates. Those updates make no DeepSeek request. `apply_prompt_to_draft` uses the
app's DeepSeek prompt feature when requested, with the configured API key and
normal provider charges. It applies the whole batch only if every proposal is
valid; a failure or clarification leaves all settings unchanged. Larger prompt
batches may need to be split into smaller selections. Enabled AI rendering
features may also use paid providers. Credentials remain in the app.

`render_draft` queues source-draft exports and returns a batch ID and job IDs;
`render_saved_edit` queues a saved-result revision and returns its new job.
`get_export` and `list_exports` report progress, usage and completed download
links. Results appear in the app's ordinary **Exports** tab. Rendering the same
submitted draft again returns the original receipt. Use `clone_draft` to make an
intentional new batch or variation.

An interrupted submission can leave a draft marked `submitting`. Check Exports
before cloning it: the batch may already be running. The MCP blocks resubmission
of that draft to avoid duplicate renders. Source and export retention still
follow the app's normal rules. Use `protect_sources` with the draft ID as owner to
keep its sources while editing; release that owner’s pins with an empty list.

## Feature coverage

The server exposes 81 typed tools. `get_editing_catalog` describes title designs,
animations, fonts and caption looks. `create_draft` / `update_draft` accept every
Auto and Manual rendering setting, including watermark masks, focus tracks,
text overlays, bulk caption corrections, audio modifiers and metadata options.
The server fills `ownFootageSourceId` from the target video rather than trusting
it as a client setting.

| Workflow | MCP tools |
| --- | --- |
| Engine, providers and models | `get_status`, `get_provider_status`, `test_provider`, `get_local_models`, `get_deepseek_balance` |
| Local sources, footage and SRT/audio | `list_videos`, `list_footage`, `list_attachments`, `import_videos`, `import_footage`, `import_attachment`, `tag_footage`, `remove_media` |
| Social imports and standalone downloader | `import_links`, `download_videos`, `download_carousels`, `list_imports`, `list_downloads`, `retry_import`, `cancel_import` |
| Batch editing and prompts | `create_draft`, `get_draft`, `list_drafts`, `clone_draft`, `update_draft`, `append_footage`, `apply_prompt_to_draft`, `get_editing_catalog` |
| Persistent Undo/Redo | `list_draft_history`, `restore_draft` |
| Reusable styles | `list_finishing_presets`, `save_finishing_preset`, `apply_finishing_preset`, `remove_finishing_preset` |
| Short discovery, transcription, pacing and speaker/face focus | `start_analysis`, `get_analysis`, `cancel_analysis`, `get_transcript`, `check_clip_history` |
| Preview and inspect media | `preview_manual`, `get_media_links`, `get_waveform` |
| Saved-result edits and prompts | `get_saved_edit`, `preview_saved_edit`, `prompt_saved_edit`, `render_saved_edit` |
| Saved drafts and source recovery | `get_saved_draft`, `save_saved_draft`, `discard_saved_draft`, `get_source_status`, `reconnect_source`, `protect_sources`, `release_source_protection` |
| Export lifecycle | `render_draft`, `list_exports`, `get_export`, `cancel_export`, `retry_export`, `rename_export`, `keep_exports`, `release_export`, `delete_exports`, `get_download_links` |
| Human and AI review | `get_export_review`, `set_export_review`, `review_export` |
| History, projects and measurements | `list_history`, `list_projects`, `set_project`, `get_measurements`, `set_measurements`, `set_publication_records` |
| Promotion profiles and post copy | `get_publishing`, `save_promotion_profile`, `import_store_profile`, `get_post_draft`, `save_post_draft`, `generate_post_copy` |
| Explicitly requested scheduling | `schedule_posts`, `refresh_publication`, `cancel_publication`, `resolve_publication` |

### Carousel downloads

Call `download_carousels` with `links` containing up to 100 Instagram post or
TikTok photo URLs, then poll `list_downloads`. Ready results report
`downloadKind: "carousel"`, `download.imageCount`, the ZIP URL and expiry.
Pass the desired ready IDs to `get_download_links` as `downloadIds`; its
`downloadsZip` groups only those posts into numbered folders with ordered
original images. To download all ready posts, explicitly select their IDs.
`retry_import` and `cancel_import` use the same IDs.

Downloads require no AI key or credits.

### Text and caption examples

Use `update_draft` with the current revision and optional `sourceIds` to select
which draft videos change. Omit `sourceIds` to edit the entire draft.

```json
{
  "auto": {
    "textEdits": [{"action":"add","text":"YOUR TITLE","design":"bold","start":0,"end":3}],
    "captionStyle": {"animation":"words"},
    "captionCorrections": [{"find":"acme","replace":"ACME","wholeWord":true,"caseSensitive":false}]
  }
}
```

Use `manual` instead of `auto` for Manual drafts. Title designs are `bold`,
`editorial`, `label` (Lower third), and `announcement`. Resize or animate existing
text with a sparse update:

```json
{"auto":{"textEdits":[{"action":"update","index":0,"style":{"fontSize":30,"animation":"pop"},"widthPercent":85}]}}
```

`index:0` selects each target video's first text object, even when their IDs differ.
An explicit existing `id` can be used instead. Other words, timings and styles stay
unchanged. Missing targets reject the whole draft update. Remove with
`{"action":"remove","index":0}` or `{"action":"remove","id":"all"}`.
Do not combine sparse `textEdits` with a complete `textOverlays` replacement.

The same capabilities work through the app's AI prompts in Quick/Auto, Manual
and saved results. Prompt proposals include reviewable summaries. Saved-result
bulk corrections change the existing cues immediately in the proposed draft;
source-draft rules apply to added captions and SRT at export. Neither changes
speech or text already baked into source pixels.

### Analysis, saved edits and bulk behavior

`start_analysis` returns immediately and runs its explicit request list in order.
Poll `get_analysis` for progress and each video's result/error. Apply returned cuts
or focus tracks through a draft after review; analysis does not render. Analysis
jobs live in the MCP process, while drafts, revision history and finishing presets
persist across client restarts. Cancellation preserves completed analysis results.

For saved results, read `get_saved_edit`, then use `preview_saved_edit` or
`prompt_saved_edit`. Only `render_saved_edit` creates a new export. Preserve the
returned job ID: unlike a submitted source draft, a revision request is not an
idempotent render receipt. Do not blindly resubmit after a timeout.

MCP presets are separate from browser-local presets. They use the same finishing
settings and exclude source-specific words, cuts and media. `restore_draft`
restores an earlier ready draft's settings as a new revision, supporting Undo/Redo
without replaying a render. Submitted drafts must be cloned for another export.

Draft edits are atomic across their selected videos. Library operations that use
several existing API calls report successes and failures per item. Publishing
reports each channel independently. Inspect those results before retrying.

### Coverage boundaries

The checked inventory is [`server/mcp/coverage.ts`](../server/mcp/coverage.ts).
[`tests/mcp-coverage.test.ts`](../tests/mcp-coverage.test.ts) checks every registered
app API route against that inventory, every Auto/Manual setting against the MCP
patch schemas, and every listed tool against the live MCP protocol. New routes or
settings fail the check until their coverage is accounted for. Integration tests
also exercise real app imports, batch MP4 rendering, title styles, SRT corrections,
saved drafts and reviews.

Credential entry/removal and model/runtime installation remain in local Settings
or setup commands; MCP reads provider/model status and tests existing connections
without receiving API keys. Browser resumable-upload chunks are replaced by local
path imports. Browser-only interactions—checkbox focus, canvas pointer gestures,
keyboard shortcuts, onboarding and unsaved local storage—are not remote UI
controls; their editing effects use typed settings, selections and MCP revision
history. This is functional coverage, not access to the browser's unsaved state.

Scheduling tools can publish through Postiz and deletion tools can remove app
media, so clients must use them only for explicitly requested actions. Editing
never implies permission to publish. Required confirmation fields and the app's
existing validation still apply. Tests use a fixture for external publishing;
they do not send real posts. There is no generic shell, filesystem or HTTP tool.
The connection remains local, not a hosted remote connector.

## Troubleshooting

- **Cannot reach Remix Studio:** start the app and check its port. MCP startup
  itself does not start a second rendering engine.
- **Build Remix Studio first:** run `npm run build` in the repository.
- **Tools missing:** restart the client or open a new session. In Claude Code,
  `/mcp` shows connection status; `codex mcp get remix-studio` shows its local
  registration.
- **Draft changed:** fetch it with `get_draft` and use the returned revision.
- **Source unavailable:** the source may have expired or been removed. Import it
  again and create a draft using its current ID.
- **Prompt timeout:** use a smaller source selection, or ask the client to apply
  explicit settings directly. The installer sets Codex's tool timeout to 180
  seconds; other clients may have their own timeout settings.
