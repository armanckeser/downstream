# Downstream

**The PR review tool for when agents open more pull requests than you can review.**

```bash
npx @armanckeser/downstream
```

You need Node 22.18 or newer, git, and the GitHub CLI signed in (`gh auth login`). The agent is Claude Code, running with your own settings.

![Downstream: the pull requests that need you, then one review from the agent's first read to the review landing on the pull request](docs/launch.gif)

- One page of every pull request that needs you, sorted into Do, Next and Delegate.
- Each change opens where control comes in, and the walkthrough follows the code that runs next.
- Ask Claude Code about the lines on screen and it answers in the margin, next to the code.
- A map lays out the whole change from its entry points, with findings on each piece.
- You see the review exactly as the author will get it, and nothing posts until you confirm.

<details>
<summary>Install as a Claude Code skill</summary>

To start reviews from Claude Code itself (*"review PR 42 with me"*), install Downstream as a [skill](SKILL.md):

```bash
git clone https://github.com/armanckeser/downstream ~/.claude/skills/downstream
cd ~/.claude/skills/downstream && npm install && npm run build
node ~/.claude/skills/downstream/bin/downstream.mjs    # the home page, from any directory
```

Downstream looks for your clone of a repository under `~/projects`, `~/code`, `~/src`, `~/dev` or `~`. Set `DOWNSTREAM_REPO_ROOTS` to search elsewhere.

</details>

Development, architecture and the agent CLI: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
