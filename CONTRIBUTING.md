# Contributing to Downstream

## Development

```bash
npm install
npm run build          # the web UI, served by the local server
npm test               # analyzer tests against throwaway git repos
npm run typecheck
DOWNSTREAM_API=http://127.0.0.1:4317 npm run dev:web   # UI with hot reload against a running review
npm pack               # what npm would publish: the UI and dist/ (the CLI and server compiled to JS)
node scripts/film/stills.mjs                         # the README stills
FILM_MJS=<film.mjs> node scripts/film/shoot.mjs      # the launch GIF (needs a frame-stepped renderer)
```

A clone runs the TypeScript sources with Node's type stripping. A published copy lives under `node_modules`, where Node won't strip types, so `npm pack` and `npm publish` compile `cli/`, `server/` and `domain/` into `dist/` first (`server/install.ts` picks which one runs).

| Path | What lives there |
|---|---|
| `SKILL.md` | The agent's instructions: the loop, what a good walkthrough contains, how to talk in the margin |
| `domain/model.ts` | The review model, shared by server, CLI and browser |
| `server/analyze/` | Git sides, TypeScript declarations, the flow graph |
| `server/actions.ts` | Every action, defined once |
| `server/publish.ts` | The review as the PR author sees it, and sending it |
| `server/analyze/py.ts` | Python declarations, imports and calls |
| `server/main.ts` | HTTP, SSE, `wait`; one server for every repository (`/r/<repo>/api`) |
| `domain/inbox.ts` | The next action for each pull request, stacks, and the Do / Next / Delegate / Someday sort |
| `domain/next-move.ts` | The one next thing to do inside a review |
| `domain/approval.ts` | Which agent tool calls run without asking |
| `server/github.ts`, `server/gh.ts` | The inbox from GitHub search, per account |
| `server/agent-host.ts`, `server/home.ts` | Agent sessions started from the home page; the home API |
| `cli/downstream.ts` | The agent's CLI |
| `web/src/` | The review surface (React, Tailwind, [Pierre diffs](https://diffs.com) and [trees](https://www.npmjs.com/package/@pierre/trees), dagre) |
| `server/install.ts` | Where Downstream's files live, in a clone or a published copy |
| `scripts/film/` | The README's GIF and stills, against a made-up inbox (a stand-in `gh`) and a made-up storefront repository |


## Releasing

GitHub Actions publishes on a version tag (`.github/workflows/publish.yml`, npm Trusted Publishing, no token or OTP). Run `npm version patch && git push --follow-tags`; the workflow checks the tag matches `package.json`, runs typecheck and tests, and `prepack` builds `dist/` and the UI. Pushing main with the tag keeps npm's README images (relative `docs/` paths) resolving.

## How it works with an agent

Downstream is a [Claude Code skill](SKILL.md). The agent drives a small CLI; you use the browser. Both go through the same actions on the same review, so either side can do anything the other can.

```bash
downstream open --pr 42          # analyze the change, open the browser
downstream show                  # the agent reads the map: doors, symbols, edges
downstream code pickNow          # and the code, numbered, with +/- marks and callers
downstream apply plan.json       # it writes the walkthrough: summary, steps, why, decisions, findings
downstream wait                  # then listens; returns when you ask, reply, resolve or finish
downstream reply 2 "…"           # and answers in the margin
downstream go openFirst          # or moves your view to what it's talking about
downstream outgoing 2 "…"        # words a finding for the author (or --exclude keeps it private)
downstream draft                 # the review exactly as it would be sent; you press Send
```

`downstream open --teach src/sync` does the same for existing code: no diff, a tour of how one request moves through that part of the system.

The analyzer does the mechanical part. It diffs the change against the merge base, finds every function, method, class, type, component and route that changed (JSDoc included), and resolves calls, renders and type uses through the TypeScript compiler. It finds unchanged callers, and works out which calls are new in the change and which disappeared. The agent does the part only a reader can: what each piece is for, the order to read it in, why it's shaped this way, and what's wrong with it.

## Built on agent-first primitives

Downstream follows the [agent-first-apps](https://github.com/armanckeser/agent-first-apps) contract, adapted to a tool that starts in a second inside any repository:

- **One source of truth.** A SQLite database per repository (`.downstream/review.db`, kept out of git), and one for the home page (`~/.downstream/home.db`: Now, pins, which repository and agent session belong to which pull request). The agent can query it read-only with `downstream sql`, and that connection cannot write.
- **One action surface.** Every change is an action defined once in `server/actions.ts` with a schema: `note.add`, `note.reply`, `steps.set`, `symbol.annotate`, `navigate`, …. The browser, the CLI and plain HTTP all call it. `downstream actions` lists them.
- **Live sync.** Every action emits an event. The browser follows them over server-sent events and updates as the agent writes.
- **Shared application state.** The browser reports what you're looking at (the view, the trail of open frames, your selected lines), so when you ask about "this" the agent already knows what this is (`downstream screen`). The agent can move your view with `navigate`.
- **Presence.** While `downstream wait` is blocked on you, the UI shows the agent as listening.

Postgres and Electric would be the agent-first default. A review is short-lived, local and per repository, though, so an embedded database and SSE keep the same guarantees with nothing to start.

## Languages

**Languages.** TypeScript and JavaScript go through the compiler: symbols, call resolution, callers, real types on hover. Python is read from indentation and imports: functions, classes and methods with decorators and docstrings, FastAPI/Flask routes as doors, calls through imports and `self`, callers across the repo, signatures and docstrings on hover. Tests in either are marked as tests. Other languages arrive as one symbol per changed file; the agent splits them into real functions and draws the edges (`addSymbols`, `edges` in `apply`).
