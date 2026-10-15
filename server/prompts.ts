// The first message of an agent session Downstream starts, by the move you
// pressed. From there the agent drives Downstream (or the repo) as usual.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, MoveKind } from "../domain/inbox.ts";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** What the agent is asked to do, by the move that was pressed. */
const PROMPTS: Partial<Record<MoveKind, (pr: { number: number; repo: string; url: string }) => string>> = {
  review: ({ number, repo }) => reviewPrompt(number, repo),
  rereview: ({ number, repo }) => `${reviewPrompt(number, repo)} I reviewed it before; start from what changed since my last review.`,
  "address-feedback": ({ number, url }) =>
    `Pull request #${number} (${url}) has review feedback I haven't addressed. Read every unresolved thread and the review comments (\`gh pr view ${number} --comments\`, and the review threads through \`gh api graphql\`). Work in a git worktree on the PR's branch so my current checkout is untouched. For each thread, tell me what you'd change and why; change code only once I agree.`,
  "fix-checks": ({ number, url }) =>
    `Checks are failing on pull request #${number} (${url}). Find the failing check and its log (\`gh pr checks ${number}\`), reproduce it locally in a git worktree on the PR's branch so my current checkout is untouched, and propose the fix before you push anything.`,
  "resolve-conflicts": ({ number, url }) =>
    `Pull request #${number} (${url}) conflicts with its base. In a git worktree on its branch, rebase onto the base (it may be part of a \`gh stack\`; if so use \`gh stack rebase\`), and walk me through each conflict before resolving it. Don't push until I say so.`,
  "finish-draft": ({ number, url }) =>
    `Pull request #${number} (${url}) is still a draft. Read the PR and its branch and tell me, in a short list, what's left before it's ready for review. Don't change anything yet.`,
};

function reviewPrompt(number: number, repo: string): string {
  return [
    `Review pull request #${number} of ${repo} with me in Downstream.`,
    `Downstream is a skill at ${skillDir}: read ${path.join(skillDir, "SKILL.md")} first and follow it.`,
    `Wherever it says \${CLAUDE_SKILL_DIR}, use ${skillDir}. Start with \`node ${path.join(skillDir, "bin", "downstream.mjs")} open --pr ${number}\`.`,
    "You're running inside Downstream: I read the review and your replies in its margin, so talk to me there and keep `downstream wait` running between turns.",
  ].join(" ");
}

export function promptFor(item: Item): string | null {
  const make = PROMPTS[item.move.kind];
  return make ? make({ number: item.lead.number, repo: item.lead.repo, url: item.lead.url }) : null;
}
