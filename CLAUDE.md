# Downstream

This is an agent-managed application. Agents working here decide and do what a request needs without an alignment or workflow-choice step (no "Plan-Execute or Align-Iterate?" question, no plan-mode ceremony). Verify the result (tests, typecheck, running it) and report what changed.

- The README's GIF and stills come from `scripts/film/`, against a made-up inbox and repository. Re-shoot them when the UI changes; never film a real account's pull requests.
- Publishing: GitHub Actions publishes on a version tag (`.github/workflows/publish.yml`, npm Trusted Publishing, no token or OTP). Run `npm version patch && git push --follow-tags`; the workflow checks the tag matches `package.json`, runs typecheck and tests, and `prepack` builds `dist/` and the UI. Pushing main with the tag keeps npm's README images (relative `docs/` paths) resolving.
