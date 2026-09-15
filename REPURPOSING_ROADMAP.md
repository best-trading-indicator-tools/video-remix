# Roadmap: consistently good automatic shorts

Date: 2026-09-15. Status: implementation in progress. The authorized first delivery covers complete-idea selection, editorial checks, bounded repair, and measured human acceptance. Each completed feature is verified, committed, and pushed to `main` separately.

## Implementation progress

| Feature | Status |
| --- | --- |
| Whole-short human acceptance | Complete. Explicit verdicts, issue categories, unknown-safe rates, median correction time, and durable CSV/JSON export extend the existing History review. Production build passed; all 274 tests covered successfully (two optional speech cases rerun with the installed local model); desktop/mobile browser review passed. |
| Complete-idea selection | Complete. Shorter context-aware candidates, bounded cached local idea discovery, validated source anchors, and indexed history/transcript lookup. Production build and all 288 tests passed. |
| Independent editorial checks | Complete as an advisory check. Separate source-cited comparisons, conservative unavailable states, actual-plan integration, and durable reports. Production build, all 307 tests, and desktop/mobile browser checks passed. The installed llama3.2 yielded only one validated (uncertain) report in four authored examples; reliable model judgment remains unproven. The opt-in smoke runner records this separately from software tests. |
| Bounded automatic repair | Next, using the validated edit-plan operations. |

The sections below retain the audit rationale and broader follow-up roadmap. Product targets remain unmeasured until real human reviews are collected.

## Objective

Increase the proportion of automatic shorts that a creator accepts without editorial corrections. Each short should deliver a complete, useful idea, preserve the source's meaning, look and sound good, and have a clear relationship to earlier exports and publications.

Support both owned recordings and third-party material with permission, with source provenance recorded explicitly. B-roll remains optional and uses existing moving footage from the user's library or Pixabay. Generating B-roll is outside this plan.

The main product measure should be **accepted shorts per hour of source material, with correction time and processing cost reported alongside it**. Counting exports alone rewards weak filler; acceptance rate alone rewards skipping everything.

## Audit baseline

The scan covered application code, shared types, UI and styles, server pipelines, scripts, tests, benchmark definitions, documentation, configuration, CI, and dependency manifests. Dependencies, generated files, media, and secret values were excluded.

- `npm run typecheck`: passed.
- `npm test`: 205 passed, zero failed or skipped.
- These results describe the original audit run. The subsequent reassessment below covers the later implementation changes.
- Existing engineering tests exercise real FFmpeg rendering and persistence as well as mocked model/provider behavior. They do not establish real-world editorial acceptance or platform outcomes.
- The current benchmark already distinguishes synthetic diagnostics from human editorial evaluation. Its automated report marks the human set as not run. Extend this foundation: [benchmark guide](benchmarks/README.md).

### Reassessment after updates through `4d193ed`

The four-step workflow remains valid. The update adds reusable editing capabilities and targeted safeguards, so the implementation should extend those foundations.

Validation on reassessment: `npm test` passed **270/270** with no skips, and `npm run typecheck` passed, including a repeat after the concurrent prompt-example/hint UI edits. Compared the 48 files changed since `5a1900c` and reviewed those additional UI edits. Model responses in the relevant tests are mocked; no real-model editorial acceptance study was run.

| Step | Current implementation | Remaining work |
| --- | --- | --- |
| Complete-idea selection | AI selects an excerpt first, then writes the headline/callouts using only that excerpt; failures preserve the selection and use its speech as the fallback hook. | Candidate scoring is still duration/density/punctuation based. Add surrounding context, complete-idea boundaries, and selection criteria for useful takeaways. |
| Editorial checks | Selected-speech grounding, validated edit operations, and technical output/B-roll checks exist. | Independently check whether the resulting cut is understandable, accurate to the source, and complete. Recheck the hook after changes to the selected cuts. |
| Bounded repair | Prompt editing supports reviewable, validated corrections. Stock B-roll can retry placement after a final motion check fails; narration has a narrow copying retry. | Connect editorial findings to targeted edit operations automatically, protect pinned choices, limit attempts, and check the revised result. Current prompt suggestions still require a user request and separate apply/render actions. |
| Measured human acceptance | Opening/ending reviews, B-roll acceptance, caption corrections, correction time, and comparison exports already exist. | Add accept-unchanged / needs-edit / reject for the whole short, reasons, missed-good-moment tracking, and a real-media baseline with editing-policy versions. |

Relevant new foundations: `server/intelligence.ts`, `server/prompt-edit.ts`, `server/prompt-routes.ts`, `server/manual-prompt.ts`, `src/PromptEditor.tsx`, and `server/supporting-plan.ts`. Structural validation of an edit does not establish that it preserves meaning. For example, one prompt can change both source cuts and the hook; the current compiler does not independently judge the hook against the resulting speech.

Begin measuring whole-short acceptance before changing selection. Then improve selection and editorial checks, followed by a repair controller that uses the existing validated edit operations. Preserve the current reviewable prompt workflow for manual requests.

### Capabilities to build on

The app already has word-timed transcription and cuts, pause removal, captions, optional local editorial AI, optional stock search and visual matching, motion-validated B-roll, editable Auto plans and immutable revisions, reviewable prompt edits with last-prompt undo, per-cut framing, technical output checks, durable export history, review metrics, large resumable imports, and a manual short-sequence editor. Manual prompts and sequence-aware rendered previews are available; their source context is settings/metadata rather than semantic analysis of the recording.

These are working foundations. The proposed improvements focus on their remaining limits.

### Findings that determine the order

| Behavior at the original audit | Why it limited automatic quality | Evidence |
| --- | --- | --- |
| Candidate score weights duration utilization 50%, speech density 30%, and sentence punctuation 20%; only eight candidates reach editorial AI. | A dense 45-second fragment can outrank a complete 24-second insight. | `server/auto-plan.ts`, candidate scoring and selection around lines 144–170 |
| Editorial AI receives excerpts, without a structured map of surrounding questions, claims, examples, and qualifications. | An opening can lose its referent, or an answer can lose the question that gives it meaning. | `server/intelligence.ts`, `writeCreativePlan` prompts |
| Hook and narration fidelity are prompt instructions without an independent meaning check. Separating packaging into a request containing only the selected excerpt reduces cross-candidate leakage. | Valid JSON and a successful render still do not establish an accurate, satisfying short. | `server/intelligence.ts`, `writeCreativePlan` output validation |
| History recognizes exact file hashes; repeat checks combine interval intersection-over-union with word overlap. | Re-encoded sources, contained excerpts, and repeated ideas across recordings can escape detection. | `server/history.ts`, lines 11–24 and 112–115; `server/diversity.ts`, lines 70–90 |
| Framing is a static focal point per cut; automatic motion is a generic push-in. | Moving speakers and important screen content can leave the crop. | `server/engine.ts`, lines 380–394 and 599 |
| Final QA checks technical faults and produces advisory warnings. | A clean file can still have an unclear opening, misleading headline, or unfinished ending. | `server/quality.ts`; `server/queue.ts`, completion paths |
| Auto corrections live in an unsaved editor draft; manual shorts and Auto use different workflows. | Users can lose corrections and need extra renders or recreate a short to access another mode's tools. | `src/EditPlanEditor.tsx`; `src/LongFormPanel.tsx`; `shared/shorts.ts` |
| Review and publication metrics exist, but observations are grouped by platform rather than individual account/post. | Learning cannot reliably distinguish two posts, comparable observation periods, or editing-policy versions. | `server/measurements.ts`, lines 142–149; `shared/types.ts`, `PostMetrics` |

## Delivery order

| Order | Work | User-visible result |
| --- | --- | --- |
| 0 | Establish a real editorial baseline. | We can demonstrate whether Auto is improving. |
| 1 | Understand the source, choose complete ideas, and check/repair the proposed edit. | More shorts make sense and deliver what their opening promises. |
| 2 | Recognize repeated footage and ideas; retain provenance and publication lineage. | Auto finds unused material and explains likely repetition. |
| 3 | Improve subject tracking, speech editing, captions, and selective B-roll. | Good ideas become clear, watchable exports. |
| 4 | Unify editing and make corrections quick and durable. | Pick moments manually or let Auto choose, then refine the same saved short. |
| 5 | Learn creator preferences and evaluate actual posted results. | Auto becomes more suitable for this creator and audience over time. |

Add operational recovery alongside the affected stages. Establish the shared edit-plan and stable source-anchor contract during phase 1, with draft autosave as an early improvement; the richer editing interface follows in phase 4.

## 0. Establish the editorial benchmark

Extend the existing benchmark with an initial 30–50 owned or permitted real sources. Include interviews, tutorials, screen recordings, demonstrations, stories, French/English speech, uncertain names and numbers, noisy audio, moving subjects, and sources that do not contain a worthwhile short.

Annotate complete ideas, required context, unacceptable meaning changes, important visual regions, and useful versus distracting B-roll. Include re-encoded copies and overlapping excerpts. Split by original recording into development and held-out evaluation sets so source versions cannot leak between them.

Compare current Auto with each proposed version using blind human review where practical. Record:

- Acceptance without editorial changes, accepted shorts per source hour, and how often a useful moment was missed.
- Opening clarity, complete payoff, preserved meaning, caption corrections, crop defects, and accepted B-roll placements.
- Active correction seconds, revision renders, elapsed processing time, and external-model cost.
- Results by content category, including the number of sources tested and reviewer disagreement.

**Completion criterion:** A repeatable baseline report exists for real media. Synthetic test success remains a separate result.

## 1. Make Auto a better editor

### Establish the shared editing foundation

Define stable cut/word IDs, source-time mappings, user-pinned decisions, and the persistent draft contract in the existing edit-plan model. Use this contract for new automatic decisions and subsequent manual-short integration. Add basic draft autosave early so repair and later timeline work preserve corrections. The richer UI can follow in phase 4.

### Understand the entire source once

Create a cached source map containing topics, speaker turns, questions and answers, examples, claims, qualifications, conclusions, and important visual moments. Every observation links back to source timestamps and transcript words. For long recordings, analyze sections and resolve connections across section boundaries.

Add a compact reusable brief: audience, purpose, content category, language/glossary, preferred pace, and examples of accepted shorts. Defaults should work without completing a long setup form.

### Choose complete ideas and distinct angles

Generate candidates around an understandable setup and a resolved takeaway. Treat target duration as a preference within the export limits. Rank candidates using required context, usefulness, specificity, payoff, and visual support.

For example, extend “That is why it failed” to include the cause, or choose a different opening. Prefer a complete 24-second explanation over padding it to 45 seconds. If the source supports two worthwhile shorts, a request for ten should return two with a clear explanation.

Support a few complementary sequences within one short: question → explanation → demonstration → conclusion. Preserve chronology by default; any rearrangement must retain attribution, qualifications, and the intended relationship between statements. Each cut keeps source anchors so captions, framing, and supporting footage remain aligned.

A proposed version should have a distinct takeaway or treatment, such as a practical demonstration versus a mistake and its correction. A different headline over the same answer is recorded as a revision.

### Check the edit before full rendering

Add an independent editorial review pass that sees the proposed timeline, source evidence, and neighboring context. Require a finding with evidence for each issue:

- Can a new viewer understand the opening?
- Does the hook accurately describe what follows?
- Does the short retain negations, qualifications, and the correct speaker?
- Does the ending resolve the promised idea?
- Are captions and any rewritten narration supported by the source?
- Would a cutaway cover a demonstration, emotional reaction, or essential text?

Source fidelity is separate from independently verifying whether the original speaker's claims are true.

Allow at most two editorial repair attempts: extend a boundary, simplify a hook, restore context, remove an unsuitable cutaway, or correct a caption. Reuse the validated operations and retiming in `server/prompt-edit.ts` / `server/edit-plan.ts` through a dedicated controller driven by findings. Recheck changed sections and preserve user-pinned decisions. Return **ready for review**, **needs correction**, or **skipped**, with concise reasons. Keep technical render status separate from editorial status.

Model judgments must be calibrated against the human benchmark. Do not present an unvalidated model score as a probability of quality or platform acceptance.

**Completion criterion:** Held-out editorial acceptance improves over current Auto without hiding useful candidates through excessive skipping; known meaning-changing edits are caught in the labeled regression set.

**Primary code:** `server/auto-plan.ts`, `server/auto.ts`, `server/intelligence.ts`, `server/prompt-edit.ts`, `server/edit-plan.ts`, `shared/types.ts`, Auto/review UI.

## 2. Recognize repetition and preserve provenance

Keep exact hashes for inexpensive identical-file detection. Add sampled video/audio signatures that recognize matching content after re-encoding, with alignment back to corresponding source intervals. Add transcript passage and idea similarity across recordings and exports.

Use both interval overlap and containment: a short wholly inside an earlier export should be visible even if their lengths differ substantially. Evaluate similarity thresholds on known duplicates and legitimate related topics before using them to suppress candidates.

Show useful explanations such as “Most of this answer appears in Short 12; this candidate adds no new example.” Suggest an unused example or a different complete idea. Let users distinguish an intentional revision or cross-platform export from a separate post on the same account.

Persist a small export manifest independently of temporary media and plans:

- Original source identity, creator, source URL when available, and ownership/permission notes or evidence.
- Stock provider/page/asset ID, creator, license reference, retrieval date, and downloaded-content hash.
- Source and stock intervals, parent revision, account/post identity, and recorded publication status.

Existing stock assets already contain much of this information; carry it into durable history before plan cleanup. Record provenance as evidence supplied or retrieved, without treating metadata as proof of ownership.

Use the existing stock identities to avoid repeatedly choosing the same generic shot across a creator's recent exports. Revalidate relevance when an edit changes what the short says.

**Completion criterion:** Labeled re-encoded duplicates, nested excerpts, and repeated ideas are identified with understandable matches; deliberate revisions remain possible; manifests survive media cleanup.

**Primary code:** `server/history.ts`, `server/diversity.ts`, `server/store.ts`, `server/stock-broll.ts`, history UI and shared types.

## 3. Make presentation follow the content

### Framing

Extend focal points to smooth, time-based crop paths. Detect shots, track people or selected objects, and use speaker turns to help choose layouts. Provide talking-head, interview pair, face-plus-screen, and demonstration layouts. Preserve readable screen text and existing captions. Low-confidence tracking should use a full-picture layout; users can select or pin the subject.

### Speech and captions

Use transcription confidence and a glossary to target uncertain regions for correction or another transcription pass. Align corrected words precisely. Group captions by phrases and language-specific reading limits, with checks for names, numbers, clipped words, and collisions.

Make pause trimming sensitive to breaths, emphasis, punchlines, and speaker changes. Preserve the original voice by default; optional narration remains a separate creator choice. Verify output audio for gaps, clipping, loudness, and synchronization.

Add a reusable creator style profile for caption font/color/phrase treatment, safe placement, headline styling, and visual density. Apply it consistently to Auto and chosen sequences while allowing each idea an appropriate layout and pace.

### Optional B-roll

Build on current contextual Pixabay search, stable matching inputs/cache, motion checks, and bounded fallback placement. The requested B-roll count is now 1–10, default four, with best-effort fulfillment and up to 60% stock coverage. Compare density settings in the benchmark rather than assuming a higher count improves quality:

- Compare the semantic relevance of several usable windows within each stock clip, including uploaded footage. Motion inspection already scans several windows; semantic matching still receives one preselected window per asset.
- Inspect the source picture to protect demonstrations, reactions, and important text.
- Choose the best set of placements across the whole short, instead of filling capacity chronologically.
- Prefer existing personal footage when equally relevant; omit uncertain matches.
- Keep original dialogue and readable captions throughout appropriate cutaways.

Zero B-roll is a valid successful result. No generated video is required.

### Output inspection

Extend existing checks with detailed sampling at edit, caption, crop, and B-roll boundaries, output-audio alignment, partial-silence detection, and actual encoded-frame-rate validation. Report what was inspected. Feed repairable findings into the bounded repair process from phase 1.

**Completion criterion:** Crop defects, caption correction burden, distracting cutaways, and audio/timing defects decrease on the real benchmark without removing useful pauses or original visual evidence.

**Primary code:** `server/engine.ts`, `server/transcription.ts`, `server/auto-plan.ts`, `server/quality.ts`, `server/broll-ai.ts`, `server/supporting-plan.ts`, `server/stock-broll.ts`, shared framing/types.

## 4. Make correction fast and persistent

Use one persistent edit plan for Auto, manual edits, and chosen short sequences. A user should be able to select two passages, pin them, apply captions/framing/optional B-roll automatically, correct a word, and export from the same workflow.

Build on phase 1's draft persistence and stable cut/word anchors. Extend current last-prompt undo into general undo/redo and complete recovery after closing the editor, then support:

- Transcript selection and sentence-aware insert/delete/reorder operations.
- Direct timing, caption, and B-roll changes in one draft, without intermediate full exports. Prompt compilation already supports retiming followed by compatible caption/shot operations; reuse it to close the remaining direct-control workflow gaps.
- Clickable quality findings that seek to the affected moment.
- Fast contextual previews of the revised timeline.
- Visual B-roll alternatives with playback at the actual insertion point.
- Batch acceptance of clear results and a focused queue for uncertain cases.

Refactor the large app component as these shared workflows are extracted. Preserve existing immutable rendered revisions.

**Completion criterion:** Draft edits survive reload/close; pinned manual sequences can receive Auto improvements; median correction time and full revision renders decrease.

**Primary code:** `src/EditPlanEditor.tsx`, `src/LongFormPanel.tsx`, `src/App.tsx`, `server/plan-storage.ts`, `server/edit-plan.ts`, `server/manual-preview.ts`, shared edit/short types.

## 5. Learn the creator's preferences and measure real outcomes

Extend the existing review system to record why a candidate, hook, cut, crop, or stock shot was accepted or rejected. Keep a small creator-approved example set and use it with the brief from phase 1. Track model, prompt, and editing-policy versions so regressions can be traced.

Store separate accounts/posts and observations at comparable publication ages, such as 24 hours and seven days. Add YouTube alongside current Instagram/TikTok measurements. Where available, compare retention, completion, saves/shares, and correction time within similar source categories and audience conditions. Keep missing metrics unknown.

Use manual entry/import first; add authorized platform integrations only where supported. Preserve actual recommendation or monetization notices separately from engagement metrics. A fall in views alone does not establish a restriction or prove that a particular edit caused it.

Add a posting package with a source-supported title, selected cover frame, platform-appropriate description, relevant attribution, and publication history. For licensed third-party material, support the creator's own recorded or written analysis with source attribution; AI can assist editing without inventing the creator's expertise, experience, or contribution.

**Completion criterion:** Preferences improve acceptance on subsequent unseen sources; reports compare individual posts over equal observation windows and do not claim causal lift from uncontrolled view counts.

**Primary code:** `server/measurements.ts`, `src/HistoryPanel.tsx`, shared metrics/profile types, editorial prompts.

## Operational work alongside the roadmap

For dependable unattended batches:

- Add FFmpeg progress-stall watchdogs, stage checkpoints, and bounded retries for transient failures.
- Resume from saved analysis/plans after interruption; avoid repeating provider work unnecessarily.
- Estimate disk needs and enforce per-batch time, resource, and external-call budgets.
- Make job completion and metadata persistence recoverable, with durable events and backups. Consider a transactional store when this requires more than the current atomic JSON writes can reliably provide.
- Cache source analysis once; inspect promising candidate/stock windows before expensive rendering.
- Show stage time and cost per accepted short.

Keep the existing local/provider boundaries. Compare configured editorial-model options on the benchmark before changing defaults; select by measured quality, latency, and cost. A model-name upgrade alone is not evidence of better editing.

## Distribution, duplicate flags, and platform limits

No repurposing tool can guarantee reach or prevent every restriction or duplicate-content decision. The product can improve distinct viewer value, detect its own repeated material, preserve provenance, and record actual platform decisions.

- **YouTube monetization:** Reused-content evaluation is separate from copyright permission; repetitive or mass-produced output can also be ineligible for monetization. This is a monetization rule, not a general test for recommendation eligibility. [YouTube channel monetization policies](https://support.google.com/youtube/answer/1311392?hl=en).
- **Instagram recommendations:** Meta's published originality guidance describes favoring the original when identical content is found. [Meta's Instagram originality explanation, May 2024](https://about.fb.com/ltam/news/2024/05/ayudando-a-los-creadores-a-encontrar-nuevas-audiencias/).
- **Facebook distribution:** Meta's March 2026 guidance says minor changes to another creator's content, such as borders, captions, or speed adjustments, do not establish meaningful originality. [Rewarding Original Creators on Facebook](https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/).
- **TikTok account recommendation status:** TikTok documents account notifications and appeals when an account becomes ineligible for recommendation. Record the actual notice and its scope. [TikTok recommendation-status help](https://support.tiktok.com/en/safety-hc/account-and-user-safety/why-is-my-account-not-being-recommended).

The design implication is to optimize useful editorial differences and accurate packaging. B-roll substitutions, cosmetic variations, or paraphrasing cannot establish platform acceptance. An internal similarity report should explain known overlap, without claiming to reproduce a platform's private detection systems.

## Proposed release targets

These are initial targets to calibrate after baseline collection, not measured capabilities or guarantees:

| Measure | Initial target |
| --- | --- |
| First-review editorial acceptance | At least 80% on the held-out representative corpus, with results broken down by content type |
| Active correction time | Median below 60 seconds per accepted short |
| Severe meaning changes | Zero missed known cases in the labeled release set; report the set size |
| Useful output | Improve accepted shorts per source hour while reporting missed worthwhile candidates |
| Supporting footage and framing | Improve human acceptance and defect rates versus the baseline |
| Operating cost | Report runtime and external cost per accepted short; enforce configured batch limits |
| Distribution conclusions | Separate technical/editorial results, actual platform notices, and observed engagement |

## Recommended first implementation slice

1. Record the real-media baseline and extend the current review labels.
2. Establish stable edit anchors and draft persistence; add the source map, complete-idea selection, and concise editorial brief.
3. Add evidence-linked editorial findings and bounded boundary/hook repair.
4. Show clear review/skip reasons and preserve user corrections.
5. Compare with current Auto on held-out sources before expanding effects or producing more variants.

Follow immediately with repetition/provenance improvements. This sequence addresses the main causes of a technically successful export still needing a human to rescue the edit.
