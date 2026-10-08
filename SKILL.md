---
name: downstream
description: Open a shared, live review surface for a code change or an area of code, then walk the user through it and discuss it there. Use when the user asks to review a PR, branch or diff ("help me review this", "review PR 42", "walk me through this change"), or to explain how existing code works ("teach me how auth works", "give me a tour of src/sync").
---

# Downstream

Downstream turns a change into something a person can read the way the code runs: start at an entry point ("a door"), follow each call downstream, and see why each piece is the way it is. You (the agent) author that walkthrough and review it; the user reads it in a browser and talks back in the margin. You both read and write the same review through the same actions, and you hear the user through `downstream wait`.

Run the CLI as `node "${CLAUDE_SKILL_DIR}/bin/downstream.mjs" <command>`. Below it is written `downstream <command>`. Run it from inside the repository being reviewed. The first run installs dependencies and builds the UI (about a minute).

## The loop

1. **Open** the review. The analyzer diffs the change, finds changed symbols, resolves calls through the TypeScript compiler, and guesses entry points.
   ```bash
   downstream open                      # working tree (incl. uncommitted) vs main
   downstream open --base main --head feature-x
   downstream open --pr 42              # uses gh; reviews without checking out
   downstream open --teach src/sync     # explain existing code instead of a diff
   ```
   It prints the URL and opens the browser. Tell the user the URL in one line, then keep working; the UI fills in live as you write.

2. **Read** before you write. `downstream show` prints the map: entry points, every symbol with its status, flow edges (`*` = new in this change), threads. `downstream code <symbol>` prints a symbol's code with real line numbers and `+`/`-` marks, plus who calls it and what it calls. Read beyond the map too (tests, callers, the PR description, `git log`) wherever you need to understand intent. Symbol ids look like `src/lib/agenda.tsx#openFirst`; most commands also accept a unique bare name.

3. **Author** the walkthrough in one batch: write a JSON file and `downstream apply plan.json` (shape below). You can apply more than once; later calls add to or replace what's there (steps are replaced as a whole, notes are added).

4. **Converse.** Run `downstream wait`. It blocks until the user replies, asks, flags, resolves, or ends the session, then prints what happened with the exact command to answer. While it blocks, the UI shows you as *listening*. Answer, then `wait` again. Keep going until `wait` reports the session ended, or the user tells you in chat they're done.

## What a good walkthrough contains

Write for a reviewer who has not seen the code. Name things; never say "it" when you can say `openFirst`. Wrap symbol names in backticks: in the UI they become links that show the code on hover and open it on click.

- **summary** (markdown, 3 to 8 sentences or a short list): what changed in behavior, in the user's terms, then where the risk is. Not a file list.
- **symbols**: a one-line purpose (`summary`) for every changed symbol and any unchanged one that matters to the flow. It answers "what is this for?", not "what does this do line by line". Fix `entry` flags: a door is where control enters the change (a route, a CLI command, an exported function called from unchanged code, a component a page renders). Unmark helpers the analyzer guessed wrong.
- **steps** (usually 3 to 8): the order to read the change, door first, then downstream along real calls. Each step anchors to a symbol (`symbolId`) and optionally `lines`, and its `body` says what happens at this point in the flow and why it's built this way. Don't repeat the code; point at the line that matters.
- **notes**, each anchored to a symbol and, when it's about specific lines, `lines` (new-side line numbers; `side: "old"` for removed code):
  - `why`: the reason behind anything that would make a careful reader stop. Write one wherever you'd expect "why is it like this?".
  - `decision`: an abstraction or interface choice, with the `alternatives` that lost and their tradeoffs. Anchor decisions about a new type, interface or class to that symbol: the overview lists every shape the change introduces with its signature and the decision beside it, so the user judges contracts before code. Ask yourself for every new type, function boundary, dependency or data shape: why this shape and not the obvious other one? Is this the right layer? If the choice looks wrong, say so in a finding instead.
  - `finding`: a real problem. `severity`: `blocker` (wrong behavior, data loss, security, will break), `concern` (likely bug, missing case, misleading code or docs, a worse abstraction than an available one), `nit` (style or small clarity). Give the failure scenario. Add a `suggestion` (`{lines, code}`) when the fix is concrete. Don't pad: three real findings beat ten weak ones.
  - `question`: you need the author's intent to judge something. The user answers in the margin.
- **edges**: add relationships the analyzer can't see (events, queues, HTTP between services, dynamic dispatch, config wiring) with a `label`. Remove noise with `removeEdges`.
- **addSymbols**: for languages other than TS/JS (they arrive as one `module` symbol per file), add the real functions with `file`, `name`, `lines`, `status`, then connect them with `edges`. In TS/JS you can pass just `line` and the declaration around it is found for you.

Set `"status": "ready"` when the walkthrough is complete.

### plan.json

```json
{
  "title": "Late-first Now card, settled items sink",
  "summary": "The Now card (`pickNow`) used to prefer…\n\nThe risky part is…",
  "status": "ready",
  "symbols": [
    { "id": "src/routes/index.tsx#pickNow", "summary": "Chooses the one task the Today screen shows in the Now card." },
    { "id": "src/lib/agenda.tsx#SETTLED", "entry": false }
  ],
  "steps": [
    { "title": "Start where the bug was felt: the Now card", "symbolId": "src/routes/index.tsx#pickNow", "lines": { "start": 41, "end": 46 },
      "body": "`TodayPage` calls `pickNow` with today's agenda. Late items are now checked first…" }
  ],
  "notes": [
    { "kind": "finding", "severity": "concern", "symbolId": "src/routes/index.tsx#pickNow", "lines": { "start": 38, "end": 38 },
      "title": "Doc comment still describes the old order", "body": "Line 38 says…",
      "suggestion": { "lines": { "start": 38, "end": 38 }, "code": "/** … */" } },
    { "kind": "decision", "symbolId": "src/lib/agenda.tsx#openFirst", "title": "A partition helper, not a comparator", "body": "…",
      "alternatives": [ { "option": "Sort with a comparator", "tradeoff": "One pass, but order then rests on sort stability." } ] },
    { "kind": "question", "symbolId": "src/routes/index.tsx#pickNow", "lines": { "start": 42, "end": 43 }, "title": "Should the newest slip win?", "body": "…" }
  ],
  "edges": [ { "from": "src/server/jobs.ts#enqueue", "to": "src/worker/run.ts#handle", "kind": "calls", "label": "via the jobs queue" } ],
  "removeEdges": [],
  "addSymbols": []
}
```

## Talking in the margin

| The user… | You run |
|---|---|
| asks a question (`wait` shows `The user asked [n_x]…` with their selected code) | `downstream reply n_x "…"` |
| replies in a thread | `downstream reply <id> "…"`, or `downstream resolve <id> "why"` if it's settled |
| pushes back on a decision | answer honestly; if they're right, say so, and offer the change |
| flags something | look at it; reply with what you found; fix it if they ask |
| says "this", "here" | `downstream screen` shows their view, open frames and selected lines |
| asks you to fix a finding | edit the code, `downstream reanalyze`, then `downstream resolve <id> "Fixed: …"` |
| gives a verdict or ends the session | acknowledge in chat; `wait` returns `The user ended the review session.` |

- `downstream go <symbol> [--lines a-b]`, `go step 3`, `go thread <id>`, `go map` moves the user's view. Use it when your answer is "look at this".
- `downstream note <kind> <symbol> --title "…" [--body "…"] [--severity …] [--lines a-b]` adds one thread without a full apply.
- `downstream ask "…" --symbol s` asks the user something.
- `downstream verdict approve|changes|comment "…"` records your overall verdict.
- `downstream sql "select * from v_notes where status = 'open'"` reads anything (read-only connection; views `v_symbols`, `v_edges`, `v_notes`, `v_replies`).
- `downstream actions` lists every action with its input schema; `downstream do <action> '<json>'` calls one directly. The browser uses the same actions, so anything the user can do, you can do.

Replies are markdown and are shown in your voice (amber) in the margin. Keep them short and specific: the claim, the evidence (a line, a caller), what you'd do.

## Teaching mode

`downstream open --teach <paths…>` maps existing code instead of a diff: every declaration is a symbol, edges are the calls between them, entries are exported functions and routes nothing else in the set calls. The job is the same minus findings unless asked: a summary of what this part of the system is for, purposes for the important symbols, a walkthrough that follows one real request or operation end to end, and `why`/`decision` notes on the shapes a newcomer would question.

## Housekeeping

- State lives in `<repo>/.downstream/` (SQLite), which is added to `.git/info/exclude`. One server per repository; `downstream status`, `downstream url`, `downstream stop`.
- Reopening (`downstream open`) starts a fresh review and makes it current; old ones stay in the database.
- If `open` fails, `.downstream/server.log` has the server's output.
