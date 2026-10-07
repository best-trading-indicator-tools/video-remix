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

Only `render_draft` queues exports. The response contains a batch ID and job IDs;
`get_export` and `list_exports` report progress, usage and completed download
links. Results appear in the app's ordinary **Exports** tab. Rendering the same
submitted draft again returns the original receipt. Use `clone_draft` to make an
intentional new batch or variation.

An interrupted submission can leave a draft marked `submitting`. Check Exports
before cloning it: the batch may already be running. The MCP blocks resubmission
of that draft to avoid duplicate renders. Source and export retention still
follow the app's normal rules; an MCP draft does not keep its media indefinitely.

## Available tools

| Purpose | Tools |
| --- | --- |
| Check the engine and library | `get_status`, `list_videos`, `list_footage` |
| Import local media | `import_videos`, `list_imports`, `import_footage` |
| Prepare and inspect edits | `create_draft`, `list_drafts`, `get_draft`, `clone_draft` |
| Change selected videos | `update_draft`, `append_footage`, `apply_prompt_to_draft` |
| Render and check progress | `render_draft`, `list_exports`, `get_export`, `cancel_export` |
| Check provider balance | `get_deepseek_balance` |

The tools do not publish posts, delete originals or expose API keys. Local file
imports are the only file-input operations; there is no generic shell, filesystem
or HTTP tool. This setup is for local clients. It does not create a remotely
accessible connector for a hosted chat service.

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
