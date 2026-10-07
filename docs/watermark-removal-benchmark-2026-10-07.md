# Local watermark removal evaluation — 7 October 2026

## Decision

Tested LaMa and STTN on the local Apple M4 Pro. Both run with modest memory in
this experiment, but neither meets the requirement of visually invisible removal
across arbitrary footage. Do not replace the production removal engine based on
these results. Prioritize LaMa for the next experiment based on the user's visual
review: its real-label result is more acceptable than STTN's incorrect inserted
phone-shaped structure. STTN's lower errors on the controlled tests do not override
that visible failure. LaMa still varies too much between frames on difficult footage.
No application code, dependencies, settings or export jobs were changed.

## Environment and provenance

- MacBook Pro, M4 Pro (20 GPU cores), 48 GB unified memory, macOS 26.4.
- Separate temporary Python 3.12 environment; PyTorch 2.14.1, NumPy 2.5.3,
  OpenCV 5.0.0. Inference used Apple MPS, float32, inference mode, six CPU threads.
- [STTN](https://github.com/researchmm/STTN), revision
  `f39f62c5bbbe3e3eba084c487353a2c651bfdcde`; official linked YouTube-VOS checkpoint.
  SHA-256: `25b0c2c30042d82efd1893bd42ec726764262d94115393a1718f8d65d2a7817b`.
  Removed an unused `torchvision.models` import in the temporary checkout only.
- [LaMa](https://github.com/advimman/lama), using the Big-LaMa TorchScript checkpoint
  linked by [IOPaint's implementation](https://github.com/Sanster/IOPaint/blob/main/iopaint/model/lama.py).
  SHA-256: `344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9`.
  MD5 matched the value published in that implementation.
- The STTN repository publishes an MIT license; LaMa publishes Apache 2.0.
  This evaluation is not a full dependency/model-distribution license audit.
- Outdoor/people clips are the STTN repository's `dogs_jump_orig.mp4` and
  `schoolgirls_orig.mp4`. The real-label example uses the local Samsung source.
  Media and model weights are not included in this commit or uploaded to a service.

## Test method

Four scenarios, plus a full-HD repeat of the real-label scenario:

1. Fixed white text label over moving outdoor footage, 48 frames at 24 fps.
2. Moving white text label over people/faces, 48 frames at 24 fps. Position changes
   every four frames; all methods receive the exact corresponding masks.
3. Large persistent opaque label covering moving subjects, 48 frames at 24 fps.
4. Real baked-in label during the first 0.5 seconds: 24 frames at 540×960, 24 fps.
5. Full-HD input repeat: 30 frames at 1080×1920, 30 fps, the same 0–0.5s removal.

For the three controlled tests, text was added to clean originals. The models
received only marked footage and masks, never the known clean originals. Originals
were used afterward for comparison. No automatic detection/tracking was evaluated.
These are short example clips, not a representative or held-out benchmark suite.

STTN used 432×240 model inputs, neighbor stride 5, reference stride 10, encoding
batches of four and decoding batches of three. Its window predictions were blended
as in the upstream example. LaMa processed individual frames; inputs were 432×240,
456×256 or 512×288. Portrait clips used a crop around the union of marked areas.
Only reconstructed patches were composited back into original-size frames.

All methods used a 1% outward feather with the selected core opaque. The production
baseline called `watermarkFilters` from revision `e5f55c8`, including adaptive
reconstruction for thick masks. Baseline input/output used raw RGB frames; model
metrics used uncompressed arrays. Review MP4s use H.264, CRF 16/17, no audio.

Full-HD input does **not** mean full-HD model inference: patches were reduced to
the model sizes above. Full-resolution reconstruction quality/performance is untested.

## Measured resources

Inference timings exclude model load, warm-up, video decoding/encoding and UI work.
GPU columns are sampled MPS counters, including cache in the driver figure. RSS
and MPS counters describe different views of shared memory and must not be added
as though they were separate physical RAM and VRAM pools. Peaks are approximate.

| Model | Peak MPS driver memory | Peak allocated MPS tensors | Process RSS peak, including HD fixture arrays |
| --- | ---: | ---: | ---: |
| LaMa | 1.40 GB | 0.35 GB | 1.95 GB |
| STTN | 2.27 GB | 1.30 GB | 1.62 GB |

| Scenario | LaMa inference | STTN inference |
| --- | ---: | ---: |
| Small fixed label, 48 frames | 5.08s | 13.02s |
| Moving label over people, 48 frames | 4.67s | 12.31s |
| Large label, 48 frames | 9.13s | 15.66s |
| Full-HD source, 30 frames / 15 masked | 2.18s | 8.96s |

The large-label STTN timing comes from a repeat run without a concurrent model
process. The initial run (17.55s) overlapped briefly with LaMa startup and was
excluded from the table. Timings fluctuate with other activity on the Mac.
LaMa skips unmasked frames; STTN also uses them as temporal references.

At these crop sizes, persistent-label tests ran at roughly 5–10 fps for LaMa and
3–4 fps for STTN. These are not end-to-end full-HD export speed guarantees.

## Quality results

| Controlled scenario | Current fill: MAE | LaMa: MAE | STTN: MAE |
| --- | ---: | ---: | ---: |
| Small fixed label | 14.51 | 10.30 | 8.00 |
| Moving label over people | 48.47 | 52.37 | 41.58 |
| Large opaque label | 27.47 | 21.58 | 20.19 |

MAE is mean absolute RGB error, 0–255, inside the selected region; lower is better.
It does not measure whether a result is visually convincing. The large-label
models can improve this average by replacing a person with plausible sky.

Frame-sequence inspection and temporal error measurements found:

- Small fixed label: STTN substantially improves sky texture and preserves the
  nearby head better. LaMa is sharper than the current fill, but varies more
  between frames.
- Moving label over people: both models visibly distort/erase faces and clothing.
  LaMa's average reconstruction error is worse than the current fill.
- Large label: both models erase or invent substantial subject detail. Not acceptable
  as invisible removal, despite lower pixel error than the blur baseline.
- Real label: LaMa produces plausible but soft background; STTN transfers incorrect
  phone/background structures into some frames. Neither is consistently invisible.
  The user specifically preferred LaMa and rejected the extra structure in STTN.

Temporal residual change (difference between consecutive reconstruction-error
maps, measured only in overlapping mask pixels) was 2.10/3.54/1.72 for the small
label, 24.69/34.00/22.18 for people, and 9.25/11.36/8.36 for the large label, in
current-fill/LaMa/STTN order. This is a diagnostic proxy, not a perceptual flicker
score. It supports the observed instability of independent LaMa frame processing.

## Local review artifacts

The comparison player, individual outputs, frame sequences, metrics, exact harness
and runtime results are in `output/watermark-benchmark-2026-10-07/` (gitignored).
Open `index.html` directly or visit
`http://127.0.0.1:5173/output/watermark-benchmark-2026-10-07/index.html` while Vite runs.
The isolated environment, temporary checkout and downloaded weights are under
`/tmp/remixer-inpainting-bench/`; application environments were not modified.
