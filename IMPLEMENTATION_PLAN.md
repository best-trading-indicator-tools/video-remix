# Remix improvements

Requested: implement one feature at a time and pass its checks before starting the next.
Existing uncommitted stock/B-roll work is the starting point and must be preserved.

## Sequence

1. [x] Stronger B-roll selection: context-aware DeepSeek search briefs, bounded candidate shortlist, local motion/window inspection, portrait-aware selection, stable analysis caching, clear reasons and provenance. Validated with mocked providers, real FFmpeg and a small live DeepSeek check. Shot preview/replacement is included in the next feature's editor.
2. [x] Correctable Auto results: saved versioned edit plans, caption/hook/cut/B-roll corrections, locked choices and per-source render scope; preview selected shots and rerender only the chosen export. Persisted snapshots, narration playback, corrections and UI validated.
3. [x] Durable export history: content fingerprints, used excerpts/angles/stock windows, export/publication status independent of media expiry. Test reimports, new batches and cleanup.
4. [x] Portrait framing and output checks: shot focal points, adjustable captions and interface guides, text collision checks, post-render media validation and review-needed findings. Test real media and UI.
5. [x] Measurement: benchmark fixtures/rubric, review ratings/correction time and manual post metrics/platform feedback, comparison/export. Test recording and reporting.

## Validation log

- Baseline: typecheck passed; full suite had an intermittent API-child startup failure under unconstrained parallelism.
- Feature 1: build/typecheck passed; full suite 85/85 passed with test concurrency capped at 2. Added bounded readiness diagnostics to the B-roll API fixture. Mocked semantic/visual APIs and real motion/crop/cache checks pass. Live DeepSeek semantic and visual checks passed with synthetic/nonprivate content.
- Feature 2: full suite 100/100; build/typecheck passed. Follow-up edit tests 15/15 passed after summary fixes. Browser uploaded two sources, rendered one, added hook/caption, produced exactly one new revision and left other source untouched; no console errors. Screenshot output/playwright/edit-result.png.
- Feature 3: full suite 117/117; build/typecheck passed. Real API/FFmpeg tests cover repeat batches, renamed bytes, concurrent imports, revisions, publication validation, deletion, restart and retention. Browser History and publication recording passed; screenshot output/playwright/history.png.
- Feature 4: full suite 135/135; build/typecheck passed. Follow-up media/editor checks passed after black-frame/actual-aspect/wrapping fixes (one new test fixture corrected; editor 12/12 passed). Browser adjusted crop and platform guides, rendered exactly one revision with deliberately overflowing captions, and confirmed Needs review findings at 0–2s. Screenshot output/playwright/framing.png.
- Feature 5 / final gate: full suite 147/147 passed; build/typecheck and diff checks passed. Measurement API 14/14 and core 8/8 passed; benchmark tests 3/3 and standalone diagnostics 9/9 passed. Ten MP4 fixtures and report saved under output/benchmark; no network calls. Browser saved reviews and dated metrics, downloaded CSV, confirmed unknown values stay blank, recorded one caption correction with 25s active time, and rendered a corrected revision with passed checks. No browser console errors. Screenshot output/playwright/measurements.png.
- All authorized features are complete. Representative speech review and real posting observations remain manual data collection; the benchmark marks its human review set as not run.

## Scope notes

- Current stock provider is Pixabay; retain its working integration.
- AI is for semantic search and visual relevance. Motion/geometry checks run locally.
- No platform acceptance score or guarantee.
- User subsequently requested committing and pushing directly to main, without a pull request.
