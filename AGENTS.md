# Working agreements

- Never create, open, or propose a pull request.
- After every task, commit all pending repository changes and push directly to `main`. This is standing authorization; do not wait for another publish request.

## Desktop release policy

- Automatically publish one desktop release when a substantial user-facing feature or workflow is complete and verified. Examples: a new editing capability, import/export workflow, setup experience, or update delivery. Bundle the feature's implementation commits into that one release.
- Small styling, copy, documentation, refactoring and routine bug fixes still go straight to `main`, but do not prepare a desktop release. They ship with the next feature release. A critical user-blocking fix can merit a patch release; explain that judgment.
- Before the final feature commit, run `npm run desktop:release -- <new-version> "Concrete user-facing release note" "Another change"`. This updates package.json, package-lock.json and desktop/release.json together. While unsigned previews are in use, choose a new `X.Y.0-preview.1` minor version for a feature, or increment the preview number for a correction to that release. Do not touch the release marker for small follow-ups.
- Pushing a changed desktop/release.json to `main` automatically builds and smoke-tests Mac, Windows and Linux, then publishes all five installers and checksums together. Do not create tags or upload release assets by hand, overwrite a published version, or mark publication complete until the workflow and public assets are verified. Fix failures, then rerun the same workflow when its code is unchanged; if fixing code after a failed release, prepare a newer version.
- Keep normal code checks on small pushes. The expensive three-platform packaging runs only for a prepared feature release or an explicitly requested manual build. Manual builds do not publish by default.
