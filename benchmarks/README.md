# Video remixer benchmark

Use this set to catch technical regressions and measure how much correction a real edit needs. Stable case IDs in [cases.json](cases.json) can be entered as the benchmark case label when recording an export review.

## 1. Run the local diagnostics

Install the project's npm dependencies and have FFmpeg and ffprobe on your PATH, then run from the project directory:

~~~sh
npm run benchmark
# Optional isolated destination; paths containing spaces are supported:
npm run benchmark -- --output "/tmp/remixer benchmark"
~~~

The command generates ten small MP4 files, a caption file, a copy of the case manifest and <code>benchmark-report.json</code> under <code>output/benchmark/</code>. It prints the report as JSON and exits with a nonzero status if a technical expectation fails or checks cannot finish. The npm script uses the existing tsx development dependency to load production TypeScript.

Only the declared <code>benchmark-*</code> artifacts are replaced. Other files and folders are preserved; symlinks or directories occupying artifact filenames are rejected. Generation uses a temporary staging directory so failed generation does not overwrite previous fixtures. Keep any real recordings under <code>output/benchmark/owned/</code>, which this script does not change.

The run is local: it uses FFmpeg, the production motion inspector, renderer, export checker and text-layout checker. It does not run transcription, AI models, stock searches, downloads, or platform publishing. It does not read your API keys. It has a 90-second limit and supports cancellation.

### What a passing report means

| Case ID | What is checked |
| --- | --- |
| tech-motion-portrait | Actual moving intervals survive portrait cropping; a healthy video with sound passes export checks. |
| tech-static-mp4 | Repeated still pixels in an MP4 fail motion selection and trigger frozen-frame review. |
| tech-late-motion | Motion after an eight-second still opening is selected; the exact still opening is rejected. |
| tech-crop-action | Motion outside the portrait crop cannot qualify a static portrait center. |
| tech-audio-missing | No audio track triggers review when sound is expected. |
| tech-audio-quiet | A present but nearly silent track triggers review. |
| tech-black-frames | Black output triggers review even when a graphic was planned. |
| tech-subject-framing | Real rendered pixels retain the red then green subject through reordered cuts at twice the speed. |
| tech-text-layout | A rendered text example has a corresponding collision warning; a safe placement has none. |

Several fixtures are deliberately broken. A successful benchmark means those failures were caught; it does not mean every generated video should pass export review. The text checker is an estimate, so inspect <code>benchmark-text-overlap.mp4</code> visually too.

These synthetic patterns and tones are **diagnostic fixtures, not representative speech videos**. Their result does not validate ASR, semantic matching, useful storytelling, source attribution, or Instagram/TikTok treatment. The report always marks the human review set as **not-run**.

## 2. Add representative speech and stock pairs

Use recordings you own or have permission to edit. Start with three clips of roughly 20–45 seconds, using the complete authored speech and review criteria in cases.json:

| Stable case label | Recording and stock pair | What to review |
| --- | --- | --- |
| editorial-work-shutdown | A person explaining an evening routine; moving footage of someone working late at or closing a laptop. Tag the stock clip: person, working late, laptop, desk. | “Couldn't switch off” should refer to finishing work. Keep a standalone opening, the useful personal example and the complete ending. Reject a literal light-switch shot. |
| editorial-context-comparison | A French comparison of paper and phone task lists; moving footage of a hand writing a paper list. Tag it: person, writing, paper, task list, notebook. | Neighboring sentences identify which list is meant. English stock queries can describe the visible action. Preserve both sides of the comparison and accurate French captions. |
| editorial-attributed-evidence | Your analysis of a real collaborator's cable-labeling demonstration, with permission; footage of hands labeling cables. Tag it: hands, labeling, cables, desk. | Credit the real creator, retain the limitation that this is one demonstration, and distinguish illustrative stock from the cited evidence. Replace the scenario's placeholder name with the actual credited person. |

The manifest includes a target audience, intended takeaway, neighboring sentences, concrete visual intent, unacceptable matches, portrait requirements and source-information checklist for each pair. These are authored scenarios to record or adapt; no existing creator, study or permission is being asserted.

Keep a small corpus of actual material representative of your channel: a clean talking head, an accented or second-language speaker, a clip with background noise, a close demonstration and a two-person comparison where appropriate. Include an ambiguous phrase, a name or number requiring careful captioning, and a shot whose action sits near an edge. Record where each source came from and any license or permission. For stock, retain the provider, asset ID, creator, source URL and selected interval.

## 3. Review in the app

1. Start the app with <code>npm run dev</code>. Upload the real speech recordings as sources and the corresponding moving shots to the B-roll library. Add the concrete tags from the manifest.
2. Select one source and its B-roll pair. Run Auto with the same language, target duration and creative settings for each comparison. Record those settings and the case label. Running Auto requires the app's normal transcription setup; enabling external AI or stock search can make paid or network calls even though the benchmark command does not.
3. Start timing active correction work when you first preview the export. Review every B-roll placement, the opening, ending, captions and framing. Use **Edit this result** to correct text, unlock and replace or remove a shot, or move the focal point. Render that revised result.
4. Record a review against the export with the matching stable case label. Count accepted and proposed B-roll shots, caption cues corrected, opening/ending judgments and active correction minutes. Put rejected matches, wrong no-match decisions, the distinct idea and attribution problems in notes.
5. Retain the same source/stock corpus and compare runs after a change. For a new source file version, keep its case label but record what changed. If export history identifies a repeated source, treat that as part of the test rather than deleting history.

Separate judgments: a shot can move correctly but depict the wrong idea; a clean export can have a misleading ending. A paraphrased headline or synthetic voice alone is not evidence of a useful new editorial contribution.

## 4. Measure posted results

After posting, enter the actual platform and observation date alongside available watch time, completion, saves/shares and exact notices. Leave unavailable values blank. Compare similar audiences, duration and observation periods. Keep different editorial approaches labeled so the comparison is meaningful.

There is no predicted originality score. Real platform outcomes and human corrections are separate from these local technical diagnostics.

## 5. Compare DeepSeek fast and thinking modes

This is a **paid, opt-in** API benchmark, separate from CI. Use separate processes
with the same model and saved workspace:

```sh
npx tsx benchmarks/thinking-ab.ts --run-deepseek --mode fast
npx tsx benchmarks/thinking-ab.ts --run-deepseek --mode thinking
```

The commands use the private `.env`; an isolated checkout can pass `--env /private/path/.env`.
Add `--workspace /path/to/video-remixer` to both commands to evaluate up to eight
completed saved edits. That reads SQLite in read-only mode and sends their saved
transcript/plan evidence through the usual text reviewer. It never changes reports,
jobs, history, source files or exports. Discovery writes only to a removed temporary cache.
`--broll-only` runs just the four authored semantic matching cases.

The suite compares six authored editorial cases, complete-excerpt selection,
source idea discovery and four B-roll meaning cases (including morning texts versus
wildlife, work versus a literal light switch, and misleading search intent).
The B-roll cases supply descriptions, not video: they do not test visual recognition,
motion, sharpness, or portrait cropping. Saved edits have no independent human labels.
Multiple edits of the same source are not independent representative videos.

Each JSON line records safe case hashes, outcomes, total latency, request count and
numeric provider usage, including retries. No transcript, API key or reasoning is
printed. Repeated cases and provider prompt caching can change latency and billed
input; compare output tokens too. At most 140 provider attempts are permitted per run.
These small diagnostics measure validity and known expected findings, not creative
acceptance. Use the real-video review process above before making broader quality claims.

### Recorded comparison — 16 September 2026

The [recorded results](results/deepseek-thinking-2026-09-16.json) include the initial
thinking budget and the final adjusted budget, all attempts, numeric usage and limitations.

| Measure | Fast | Final low thinking |
| --- | ---: | ---: |
| Authored expected outcomes matched | 11/11 | 11/11 |
| Saved editorial reviews completed | 6/7 | 7/7 |
| Median editorial review time | 2.84 s | 21.24 s |
| Valid source idea proposals in the discovery case | 0 | 1 |
| Provider attempts across 19 cases | 24 | 20 |

Seven saved edits used two transcript snapshots; only one source video was currently
imported. This sample supports testing the integration and its trade-offs, not a claim
of better creative judgment across a representative channel. Completed reviews can
still flag issues. Both modes rejected the authored irrelevant B-roll examples.
