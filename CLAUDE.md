# Downstream

This is an agent-managed application. Agents working here decide and do what a request needs without an alignment or workflow-choice step (no "Plan-Execute or Align-Iterate?" question, no plan-mode ceremony). Verify the result (tests, typecheck, running it) and report what changed.

- The README's GIF and stills come from `scripts/film/`, against a made-up inbox and repository. Re-shoot them when the UI changes; never film a real account's pull requests.
- Publishing: `npm publish` compiles `dist/` and builds the UI in `prepack`. Bump the version first, and push before publishing so npm's README images (relative `docs/` paths) resolve.
