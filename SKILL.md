---
name: downstream
description: Open a shared, live review surface for a code change or an area of code, walk the user through it, discuss it with them there, and (for pull requests) send the review you arrive at together. Use when the user asks to review a PR, branch or diff ("help me review this", "review PR 42", "walk me through this change"), or to explain how existing code works ("teach me how auth works", "give me a tour of src/sync"). TypeScript, JavaScript and Python are analyzed; other languages are mapped by hand.
---

# Downstream

Downstream turns a change into something a person can read the way the code runs: start at an entry point ("a door"), follow each call downstream, and see why each piece is the way it is. You (the agent) map the change, write the walkthrough, and review it; the user reads it in a browser and talks to you in the margin; together you arrive at a review, and when the user says so, it goes to the pull request. You both read and write the same review through the same actions, and you hear the user through `downstream wait`.

Run the CLI as `node "${CLAUDE_SKILL_DIR}/bin/downstream.mjs" <command>`. Below it is written `downstream <command>`. Run it from inside the repository being reviewed. The first run installs dependencies and builds the UI (about a minute).

## The loop

1. **Open** the review.
   ```bash
   downstream open --pr 42              # someone's pull request (uses gh; no checkout needed)
   downstream open                      # working tree (incl. uncommitted) vs main
   downstream open --base main --head feature-x
   downstream open --teach src/sync     # explain existing code instead of a diff
   ```
   It prints the URL and opens the browser. Tell the user the URL in one line, then keep working; the UI fills in live as you write.

2. **Understand** before you judge. `downstream show` prints the map: doors, every symbol with its status, flow edges (`*` = new in this change, `x` = removed), tests, threads. `downstream code <symbol>` prints a symbol's code with real line numbers and `+`/`-` marks, plus who calls it and what it calls. Then read past the map: the PR description, the callers of every changed function, the tests, where data comes in, what is stored, what goes out. A change can break code it doesn't touch: when a signature, return value or behavior changes, check every caller. Find the expected load (README, deploy config) and judge scale against it.

3. **Write** the walkthrough and your review in one batch: a JSON file and `downstream apply plan.json` (shape below). You can apply again; steps are replaced as a whole, notes are added, `updates` edit existing threads.

4. **Converse.** Run `downstream wait`. It blocks until the user replies, asks, flags, edits, resolves or ends the session, then prints what happened with the exact command to answer (and their selected code, when they asked about a selection). While it blocks, the UI shows you as *listening*. Answer, then `wait` again.

5. **Arrive at the review.** When the conversation settles, draft what the author will read (see *Sending the review*). The user checks it in **Send review** and sends it, or tells you to.

## What to look for

Review like the senior developer who gets paged when it breaks. In order: correct, safe, holds under the expected load, tested, fast, lean.

- **bug**: wrong result, crash, missed edge case (empty, zero, last item, rounding, time zones), a caller broken by the change, a fix in one caller while the shared function stays broken.
- **risk**: security (injection, secrets, unchecked user input), data loss (swallowed errors, writes in the wrong order, no transaction), migrations that change what existing rows mean.
- **scale**: fine for one user, wrong for many: check-then-write races, a query per item, unbounded growth, per-process state that must be shared.
- **test**: risky new logic (a branch, a parser, money, security, data writes, a bug fix) with no test that fails when it breaks. One good test, not coverage.
- **speed**: big slowdowns are findings; small wins are nice-to-haves.
- **lean**: code that shouldn't exist (dead, speculative, an abstraction with one implementation), a helper the repo already has (name the path), a dependency for a few lines, near-copies that must change together.

Every finding needs a concrete case: *this input or situation leads to this wrong result*. No case, no finding. Re-read the lines before you report: confirm the caller exists, the value can really be empty, the code really is unused. Propose the smallest fix that works; prefer fixes that delete code. No style taste, no "consider", no vague worries. Three real findings beat ten weak ones.

## What a good walkthrough contains

Write for a reader who has not seen the code: short sentences, everyday words, explain a term the first time. Name things; never say "it" when you can say `openFirst`. Wrap symbol names in backticks: in the UI they become links that show the code on hover and open it on click.

- **summary** (3 to 8 sentences or a short list): what this change does, in behavior, then where the risk is. Not a file list.
- **symbols**: a one-line purpose (`summary`) for every changed symbol and any unchanged one that matters to the flow ("what is this for?"). Fix `entry` flags: a door is where control enters the change (a route, a job, a CLI command, an exported function called from unchanged code, a component a page renders). Unmark what the analyzer guessed wrong.
- **steps** (usually 3 to 8): the order to read the change, door first, then downstream along real calls. Each step anchors to a symbol (`symbolId`) and usually `lines`; its `body` says what happens at this point in the flow and why it's built this way. Point at the line that matters; don't repeat the code.
- **notes**, each anchored to a symbol and, when about specific lines, `lines` (new-side numbers; `side: "old"` for removed code). Every note gets a number (`#1`, `#2`, …) the user can refer to; commands accept `3` or `#3` wherever they take a thread.
  - `finding`: `severity` is `blocker` (shown as **must fix**: bug, security, data loss, breaks at the expected load), `concern` (**should fix**: risky code without a test, real slowness, duplication, code that shouldn't exist) or `nit` (**nice to have**). Set `category` (bug, risk, scale, test, speed, lean). `title` names the problem; `body` is the problem with its concrete case; `fix` is the smallest fix; `impact` says what happens if we ship it anyway; `suggestion` (`{lines, code}`) when the fix is concrete. A suggestion whose lines match the note's lines becomes a GitHub suggestion the author can apply in one click.
  - `decision`: an abstraction or interface choice, with the `alternatives` that lost and their tradeoffs. For every new type, function boundary, dependency or data shape ask: why this shape and not the obvious other one? Is this the right layer? Anchor it to the shape's symbol; the overview shows each shape with its decision.
  - `why`: the reason behind anything that would make a careful reader stop.
  - `question`: you need the author's (or user's) intent to judge something.
- **edges**: relationships the analyzer can't see (events, queues, HTTP between services, dynamic dispatch, DI wiring), with a `label`. `removeEdges` for noise.
- **addSymbols**: for other languages (they arrive as one `module` symbol per file) add the real functions with `file`, `name`, `lines`, `status`, then connect them with `edges`. In TS/JS/Python you can pass just `line` and the declaration around it is found.

Set `"status": "ready"` when the walkthrough is complete.

### plan.json

```json
{
  "summary": "Price tracking stops being something you switch on…\n\nThe risk is in the migration: …",
  "status": "ready",
  "symbols": [
    { "id": "backend/app/features/price_tracking/service.py#apply_price_observation", "summary": "Records a fetched price; now also turns tracking on." },
    { "id": "backend/app/features/wishlist_item/models.py#WishlistItem", "entry": false }
  ],
  "steps": [
    { "title": "Tracking turns on when a check succeeds", "symbolId": "backend/app/features/price_tracking/service.py#apply_price_observation",
      "lines": { "start": 267, "end": 271 }, "body": "A price we could read proves the page is trackable, so…" }
  ],
  "notes": [
    { "kind": "finding", "severity": "blocker", "category": "risk", "symbolId": "backend/app/alembic/versions/f1a2_add_flag.py#upgrade",
      "lines": { "start": 19, "end": 27 }, "title": "Everyone who turned tracking off is opted back in",
      "body": "The new column defaults to false for every existing row, so an item whose owner switched tracking off…",
      "fix": "Backfill in upgrade(): items that had a verified price and are off without a pause were turned off by their owner.",
      "impact": "Owners who opted out start getting price notifications again the day this deploys.",
      "suggestion": { "lines": { "start": 19, "end": 27 }, "code": "    op.add_column(…)\n    op.execute(\"UPDATE …\")" } },
    { "kind": "decision", "symbolId": "backend/app/background/price_check.py#check_tracked_prices", "title": "Group by store instead of a global rate limiter",
      "body": "…", "alternatives": [ { "option": "One global queue with a smaller delay", "tradeoff": "Every site sees faster requests." } ] },
    { "kind": "question", "symbolId": "backend/app/background/price_check.py#check_tracked_prices", "title": "Is one scheduler process the expected deployment?", "body": "…" }
  ],
  "updates": [ { "noteId": "2", "outgoing": { "include": true, "body": "…" } } ],
  "outgoingBody": "…",
  "edges": [ { "from": "src/server/jobs.ts#enqueue", "to": "src/worker/run.ts#handle", "kind": "calls", "label": "via the jobs queue" } ]
}
```

Two full examples from real reviews live in `examples/` (`kumbara-equity-grants.json` for TypeScript, `wishlist-auto-tracking.json` for Python).

## Talking in the margin

| The user… | You run |
|---|---|
| asks a question (`wait` shows `The user asked [n_x]…` with their selected code) | `downstream reply n_x "…"` |
| replies in a thread | `downstream reply 3 "…"`, or `downstream resolve 3 "why"` when it's settled |
| pushes back on a finding or decision | answer honestly. If they're right, say so and `resolve` or `dismiss` it with the reason; if the finding changes, `downstream do note.update '{"noteId":"3","body":"…"}'` |
| says "this", "here" | `downstream screen` shows their view, open frames and selected lines |
| says "fix 2 and 5" (their own code) | edit the code, `downstream reanalyze`, then `downstream resolve 2 "Fixed: …"` |
| edits a thread's outgoing wording | `wait` reports it; leave their wording alone unless asked |
| gives a verdict, sends, or ends the session | acknowledge in chat |

- `downstream go <symbol> [--lines a-b]`, `go step 3`, `go thread 3`, `go map` moves the user's view. Use it when your answer is "look at this".
- `downstream note <kind> <symbol> --title "…" [--body] [--severity] [--category] [--fix] [--impact] [--lines a-b]` adds one thread without a full apply.
- `downstream ask "…" --symbol s` asks the user something.
- `downstream sql "select * from v_notes where status = 'open'"` reads anything (read-only connection; views `v_symbols`, `v_edges`, `v_notes`, `v_replies`).
- `downstream actions` lists every action with its input schema; `downstream do <action> '<json>'` calls one. The browser uses the same actions, so anything the user can do, you can do.

Replies are markdown, shown in your voice in the margin. Keep them short: the claim, the evidence (a line, a caller), what you'd do.

## Sending the review

The conversation in the margin is between you and the user and never leaves. What the PR author reads is a separate, explicit draft:

- **Which threads go out.** Open findings go out by default; everything else stays private. Change that per thread: `downstream outgoing 3 "…"` (send, in these words) or `downstream outgoing 4 --exclude` (keep private). Findings the user dismissed or resolved in conversation should not go out.
- **The words.** Without outgoing wording, a finding goes out as written (severity, title, problem, fix, suggestion, impact). Reword when the conversation changed the finding, or when it should read as a question to the author. Write to the author, not to the user: no references to your conversation, and no `#3` thread numbers (on GitHub those link to issues and pull requests); name the problem instead.
- **The body.** `outgoingBody` (via `apply` or `downstream do review.update '{"outgoingBody":"…"}'`): what the change does in a sentence or two, what must change before merging, and anything you could not check. Plain and kind.
- **The verdict.** `downstream verdict changes|approve|comment "…"`. GitHub doesn't allow approving or requesting changes on your own pull request; use comment there.
- `downstream draft` prints exactly what would be sent: the event, the body, each inline comment, and the comments that fall outside the diff (GitHub only takes inline comments on changed lines and their context, so those go into the body).

Sending is public and permanent. **Never run `downstream send` on your own initiative.** The user sends from the Send review panel, or tells you to in chat ("send it"); then run `downstream draft`, show them the verdict and the number of comments in one line, and send only after they confirm. Only pull request reviews (`open --pr`) can be sent; for anything else the panel copies the review as markdown.

## Languages

- **TypeScript / JavaScript**: the compiler resolves calls, renders, type uses and callers; hover shows real types and docs. Inner functions of large containers (Effect service layers, app builders) are lifted into their own symbols, and a service's `return { createGrant }` is followed back to the function.
- **Python**: declarations come from indentation (decorators and docstrings included); FastAPI/Flask/Celery-style decorators mark routes and jobs as doors. Calls are resolved through each file's imports, `self.`/`cls.`, fresh instances (`Service().create()`), and unique method names; callers are found across the repo; hover shows the signature and docstring. There is no type checker: when a call goes through an injected object the analyzer can't see, add the edge yourself.
- **Tests** are marked as tests: never doors, shown on a frame as *tested by*, hidden on the map unless toggled.

## Teaching mode

`downstream open --teach <paths…>` maps existing code instead of a diff: every declaration is a symbol, edges are the calls between them, doors are exported functions and routes nothing else in the set calls. The job is the same minus findings unless asked: what this part of the system is for, purposes for the important symbols, a walkthrough that follows one real request or operation end to end, and `why`/`decision` notes on the shapes a newcomer would question. Large maps open scoped to your walkthrough.

## Housekeeping

- State lives in `<repo>/.downstream/` (SQLite), added to `.git/info/exclude`. One server per repository; `downstream status`, `downstream url`, `downstream stop`. An updated skill restarts the server and rebuilds the UI on the next `open`.
- `downstream reanalyze` re-reads the code after edits and keeps summaries, threads and the walkthrough.
- Reopening (`downstream open`) starts a fresh review and makes it current; old ones stay in the database.
- If `open` fails, `.downstream/server.log` has the server's output.
