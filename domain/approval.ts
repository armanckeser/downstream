// Which of the agent's tool calls run without asking you. Reading never needs
// permission; changing anything (files, git history, GitHub) does, and so does
// sending the review, which the agent must never do on its own.

/** Tools that only read. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch", "Skill", "ToolSearch", "Agent", "Task", "TaskOutput"]);

/**
 * Shell commands that only read, and the flags that would make them run or
 * write something (`rg --pre`, `fd --exec`, `sort -o`, `sed -i`, `find -delete`).
 */
const READ_COMMANDS: Record<string, RegExp | null> = {
  cat: null, head: null, tail: null, wc: null, ls: null, grep: null, cut: null, tr: null, echo: null, printf: null, pwd: null,
  which: null, file: null, stat: null, diff: null, basename: null, dirname: null, realpath: null, true: null, jq: null, nl: null, column: null, uniq: null,
  read: null,
  rg: /^--pre/,
  fd: /^(-x|-X|--exec|--exec-batch)/,
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  sed: /^(-i|--in-place)/,
  find: /^-(exec|execdir|delete|ok|fprint)/,
};

const GIT_READ = new Set(["log", "show", "diff", "status", "rev-parse", "merge-base", "ls-files", "blame", "grep", "fetch", "cat-file", "describe", "shortlog", "rev-list", "ls-tree", "remote"]);
const GH_READ: Record<string, Set<string>> = {
  pr: new Set(["view", "diff", "checks", "list", "status"]),
  repo: new Set(["view"]),
  run: new Set(["view", "list"]),
  issue: new Set(["view", "list"]),
};
/** Downstream subcommands that publish: always yours to approve. */
const DOWNSTREAM_PUBLISH = new Set(["send"]);

export type Verdict = { allow: true } | { allow: false; reason: string };

/**
 * `skillDir` is where Downstream lives, so `node <skillDir>/bin/downstream.mjs …`
 * is recognized as the Downstream CLI.
 */
export function autoApprove(tool: string, input: Record<string, unknown>, skillDir: string): Verdict {
  if (READ_TOOLS.has(tool)) return { allow: true };
  if (tool !== "Bash") return { allow: false, reason: `${tool} can change things` };
  const command = typeof input.command === "string" ? input.command : "";
  return readOnlyShell(command, skillDir);
}

function readOnlyShell(command: string, skillDir: string): Verdict {
  // Discard harmless stderr plumbing first, then refuse anything that could write or hide a second command.
  const plain = command.replace(/\s2>&1/g, " ").replace(/\s2>\s*\/dev\/null/g, " ");
  const substituted = substitutions(plain, skillDir);
  if ("allow" in substituted) return substituted;
  if (/[>`]|\$\(|<\(|\bsudo\b/.test(substituted.rest)) return { allow: false, reason: "redirects, substitutions or sudo" };
  for (const raw of substituted.rest.split(/&&|\|\||;|\||\n/)) {
    const words = withoutLoopKeywords(raw.trim().split(/\s+/).filter(Boolean));
    if (words.length === 0) continue;
    const verdict = readOnlyCommand(words, skillDir);
    if (!verdict.allow) return verdict;
  }
  return { allow: true };
}

/** Stands in for a `$(…)` already judged read-only: an expansion like `$f`, so it gets the same suspicion. */
const SUBSTITUTED = "$SUBSTITUTED";

/** Judge each `$(…)` on its own and replace it with an expansion; a refusal inside refuses the whole command. */
function substitutions(command: string, skillDir: string): { rest: string } | { allow: false; reason: string } {
  let rest = command;
  for (let start = rest.indexOf("$("); start !== -1; start = rest.indexOf("$(")) {
    const end = closingParen(rest, start + 2);
    if (end === -1) return { allow: false, reason: "an unclosed substitution" };
    const inner = readOnlyShell(rest.slice(start + 2, end), skillDir);
    if (!inner.allow) return inner;
    rest = `${rest.slice(0, start)}${SUBSTITUTED}${rest.slice(end + 1)}`;
  }
  return { rest };
}

function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** `for f in …; do cat $f; done`: the loop's words are syntax; what runs is the command after them. */
function withoutLoopKeywords(words: string[]): string[] {
  const [first] = words;
  if (first === "done" || first === "fi") return words.slice(1);
  if (first === "for") return [];
  if (first === "do" || first === "then" || first === "else" || first === "while" || first === "until" || first === "if") return withoutLoopKeywords(words.slice(1));
  return words;
}

/** Programs people often call by path (`~/.local/bin/gh`, `/usr/bin/git`): judged by name, like the bare command. */
const BY_NAME = new Set(["gh", "git"]);

function readOnlyCommand(words: string[], skillDir: string): Verdict {
  const [first, ...args] = words as [string, ...string[]];
  const base = first.split("/").at(-1)!;
  const cmd = first.includes("/") && BY_NAME.has(base) ? base : first;
  if (cmd === "cd") return { allow: true };
  if (cmd.includes("$")) return { allow: false, reason: "the program itself is an expansion" };
  // An expanded value is unseen text: `git show $f` with f = `x --output=~/.zshrc` writes a file. Only programs no flag can turn into a write take one.
  const expanded = args.some((a) => a.includes("$"));
  if (Object.hasOwn(READ_COMMANDS, cmd)) {
    const risky = READ_COMMANDS[cmd];
    if (risky && expanded) return { allow: false, reason: `an expanded argument to ${cmd} could be a flag` };
    const flag = risky ? args.find((a) => risky.test(a)) : undefined;
    return flag ? { allow: false, reason: `${cmd} ${flag} can run or write` } : { allow: true };
  }
  const downstreamArgs = downstreamCall(cmd, args, skillDir);
  if ((cmd === "git" || cmd === "gh" || downstreamArgs) && expanded) return { allow: false, reason: `an expanded argument to ${cmd} could be a flag or a send` };
  if (cmd === "git") return gitRead(args);
  if (cmd === "gh") return ghRead(args);
  if (downstreamArgs) {
    const [sub, ...rest] = downstreamArgs;
    const publishes = (sub !== undefined && DOWNSTREAM_PUBLISH.has(sub)) || rest.some((a) => a.includes("review.publish"));
    return publishes ? { allow: false, reason: "sending the review is yours to approve" } : { allow: true };
  }
  return { allow: false, reason: `${cmd} isn't known to be read-only` };
}

/** The args after `downstream`, if this is the Downstream CLI. */
function downstreamCall(cmd: string, args: string[], skillDir: string): string[] | null {
  if (cmd === "downstream") return args;
  const script = args[0]?.replace(/^["']|["']$/g, "");
  const ours = script === `${skillDir}/bin/downstream.mjs` || script?.endsWith("/bin/downstream.mjs");
  return cmd === "node" && ours ? args.slice(1) : null;
}

function gitRead(args: string[]): Verdict {
  const rest = args[0] === "-C" ? args.slice(2) : args;
  const sub = rest[0];
  if (rest.some((a) => a.startsWith("--output") || a.startsWith("--ext-diff"))) return { allow: false, reason: "git writing to a file or running a diff tool" };
  if (sub === "branch" || sub === "worktree") {
    const listing = sub === "branch" ? !rest.slice(1).some((a) => /^-[dDmMcC]|^--(delete|move|copy)/.test(a)) : rest[1] === "list";
    return listing ? { allow: true } : { allow: false, reason: `git ${sub} can change things` };
  }
  if (sub === "remote" && rest.length > 2) return { allow: false, reason: "git remote can change things" };
  return sub && GIT_READ.has(sub) ? { allow: true } : { allow: false, reason: `git ${sub ?? ""} can change things`.trim() };
}

function ghRead(args: string[]): Verdict {
  const [group, verb] = args;
  if (group === "api") {
    const at = args.findIndex((a) => a === "-X" || a === "--method");
    const writes = at !== -1 && args[at + 1]?.toUpperCase() !== "GET";
    const graphql = args[1] === "graphql";
    const fields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a));
    if (writes) return { allow: false, reason: "gh api with a write method" };
    if (graphql) return args.some((a) => /\bmutation\b/.test(a)) ? { allow: false, reason: "a GraphQL mutation" } : { allow: true };
    return fields ? { allow: false, reason: "gh api with fields posts" } : { allow: true };
  }
  return group && verb && GH_READ[group]?.has(verb) ? { allow: true } : { allow: false, reason: `gh ${group ?? ""} ${verb ?? ""} can change things`.trim() };
}

/**
 * Commands that reach other people: sending the review, posting or merging on
 * GitHub, pushing. The agent runs in auto mode, where a classifier approves
 * most calls; these always come to you, whatever the classifier would say.
 * Matched across the whole command, so a push inside `$(…)` or after `&&` counts.
 */
const OUTWARD: [RegExp, string][] = [
  [/\bdownstream(\.mjs)?["']?\s+send\b/, "sending the review"],
  [/\breview\.publish\b/, "sending the review"],
  [/\bgit\b(\s+-C\s+\S+)?\s+push\b/, "pushing to GitHub"],
  [/\bgh\s+pr\s+(review|comment|merge|close|reopen|create|edit|ready)\b/, "changing a pull request on GitHub"],
  [/\bgh\s+issue\s+(comment|create|close|reopen|edit)\b/, "changing an issue on GitHub"],
  [/\bgh\s+(release|repo)\s+(create|delete|edit)\b/, "changing a repository on GitHub"],
  [/\bgh\s+api\b[^|;&]*(-X|--method)[\s=]*(POST|PATCH|PUT|DELETE)\b/i, "writing through the GitHub API"],
  [/\bgh\s+api\s+graphql\b[^|;&]*\bmutation\b/, "a GitHub GraphQL mutation"],
];

export function reachesOthers(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "Bash") return null;
  const command = typeof input.command === "string" ? input.command : "";
  const restFields = /\bgh\s+api\s+(?!graphql\b)[^|;&]*\s(-f|-F|--field|--raw-field|--input)\s/.test(command) && !/(-X|--method)[\s=]*GET\b/i.test(command);
  if (restFields) return "writing through the GitHub API";
  return OUTWARD.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}
