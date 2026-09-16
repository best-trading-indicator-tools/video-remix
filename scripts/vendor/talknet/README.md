TalkNet inference architecture from Sieve fast-asd, commit
`a6cab6e92baedf70b1976b856ee7caeb417e604e`:
https://github.com/sieve-community/fast-asd/tree/a6cab6e92baedf70b1976b856ee7caeb417e604e/talknet/model

Four architecture files are retained under the upstream MIT license (see LICENSE).
No Sieve service, training code, face detector download, or CUDA dependency is used.
Original TalkNet research: https://arxiv.org/abs/2107.06592

Pretrained TalkSet weights are downloaded separately by `npm run setup:speaker`
from the upstream-linked model URL, verified by SHA-256, and loaded with
PyTorch `weights_only=True`. They are not committed to this repository.
