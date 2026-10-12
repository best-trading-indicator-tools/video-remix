# Working agreements

- Never create, open, or propose a pull request.
- After every task, commit all pending repository changes and push directly to `main`. This is standing authorization; do not wait for another publish request.

## Desktop release policy

- Build desktop installers or publish a desktop release only when the user explicitly asks. Completing a feature or fix does not authorize packaging or publication. Keep committing and pushing ordinary work to `main` with normal code checks; accumulate changes until the user requests a desktop build or release.
- For an installer build without publication, manually dispatch `desktop.yml` on `main` with `publish=false` (the default). Do not prepare a new release version just to test installers.
- When the user requests a desktop release, run `npm run desktop:release -- <new-version> "Concrete user-facing release note" "Another change"`. This updates package.json, package-lock.json and desktop/release.json together. While unsigned previews are in use, choose a new `X.Y.0-preview.1` minor version for bundled features, or increment the preview number for a correction to that release. Commit and push the version files, then manually dispatch `desktop.yml` on `main` with `publish=true`.
- The desktop workflow is manual only. Pushing code or changing desktop/release.json never starts installer builds. An explicitly requested release builds and smoke-tests Mac, Windows and Linux, then publishes all five installers and checksums together. Do not create tags or upload release assets by hand, overwrite a published version, or mark publication complete until the workflow and public assets are verified. Fix failures, then rerun the same workflow when its code is unchanged; if fixing code after a failed release, prepare a newer version.
