# Working agreements

- Never create, open, or propose a pull request.
- After every task, commit all pending repository changes and push directly to `main`. This is standing authorization; do not wait for another publish request.

## Feature completeness

- Every new user-facing feature, including extensions to existing features, must also be supported by the AI prompt editor and bulk-video mode. These are part of the feature's acceptance criteria, not optional follow-up work.
- Quick mode is a primary workflow: expose new editing capabilities there and let users apply them to checked videos or all videos without editing each video individually. Preserve unchecked videos and unrelated settings on each target.
- Wire AI support through the complete proposal-to-application flow: schemas, model instructions, current-state context, validation, change summaries, and applying the result. Cover Quick/Auto, Manual, and saved-result prompts wherever the feature is available, and preserve the feature when switching modes.
- Before declaring a feature complete, verify its UI, AI prompt, and bulk-video paths together, including the requested target selection and existing Undo/persistence behavior. Do not defer prompt or bulk support unless the user explicitly narrows the scope.

## Desktop release policy

- Build desktop installers or publish a desktop release only when the user explicitly asks. Completing a feature or fix does not authorize packaging or publication. Keep committing and pushing ordinary work to `main` with normal code checks; accumulate changes until the user requests a desktop build or release.
- For an installer build without publication, manually dispatch `desktop.yml` on `main` with `publish=false` (the default). Do not prepare a new release version just to test installers.
- When the user requests a desktop release, run `npm run desktop:release -- <new-version> "Concrete user-facing release note" "Another change"`. This updates package.json, package-lock.json and desktop/release.json together. While unsigned previews are in use, choose a new `X.Y.0-preview.1` minor version for bundled features, or increment the preview number for a correction to that release. Commit and push the version files, then manually dispatch `desktop.yml` on `main` with `publish=true`.
- The desktop workflow is manual only. Pushing code or changing desktop/release.json never starts installer builds. An explicitly requested release builds and smoke-tests Mac, Windows and Linux, then publishes all five installers and checksums together. Do not create tags or upload release assets by hand, overwrite a published version, or mark publication complete until the workflow and public assets are verified. Fix failures, then rerun the same workflow when its code is unchanged; if fixing code after a failed release, prepare a newer version.
