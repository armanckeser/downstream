// The first message of an agent session Downstream starts, by the move you
// pressed. From there the agent drives Downstream (or the repo) as usual.
import path from "node:path";
import type { Item, MoveKind } from "../domain/inbox.ts";
import { packageRoot } from "./install.ts";

const skillDir = packageRoot;

/** What the agent is asked to do, by the move that was pressed. */
type PromptInput = { number: number; repo: string; url: string; opened: boolean };

const PROMPTS: Partial<Record<MoveKind, (pr: PromptInput) => string>> = {
  review: ({ number, repo, opened }) => reviewPrompt(number, repo, opened),
  rereview: ({ number, repo, opened }) => `${reviewPrompt(number, repo, opened)} I reviewed it before; start from what changed since my last review.`,
  "address-feedback": ({ number, url }) =>
    `Pull request #${number} (${url}) has review feedback I haven't addressed. Read every unresolved thread and the review comments (\`gh pr view ${number} --comments\`, and the review threads through \`gh api graphql\`). Work in a git worktree on the PR's branch so my current checkout is untouched. For each thread, tell me what you'd change and why; change code only once I agree.`,
  "fix-checks": ({ number, url }) =>
    `Checks are failing on pull request #${number} (${url}). Find the failing check and its log (\`gh pr checks ${number}\`), reproduce it locally in a git worktree on the PR's branch so my current checkout is untouched, and propose the fix before you push anything.`,
  "resolve-conflicts": ({ number, url }) =>
    `Pull request #${number} (${url}) conflicts with its base. In a git worktree on its branch, rebase onto the base (it may be part of a \`gh stack\`; if so use \`gh stack rebase\`), and walk me through each conflict before resolving it. Don't push until I say so.`,
  "finish-draft": ({ number, url }) =>
    `Pull request #${number} (${url}) is still a draft. Read the PR and its branch and tell me, in a short list, what's left before it's ready for review. Don't change anything yet.`,
};

/**
 * `opened`: Downstream already ran `open --pr` itself, so the user sees the
 * change's shape while the agent reads; the agent starts at `show` instead.
 */
function reviewPrompt(number: number, repo: string, opened: boolean): string {
  const cli = `node ${path.join(skillDir, "bin", "downstream.mjs")}`;
  const start = opened
    ? `Downstream has already opened this pull request as the current review (fetched, diffed and analyzed), and I'm looking at it. Don't run \`open\`; start with \`${cli} show\`.`
    : `Start with \`${cli} open --pr ${number}\`.`;
  return [
    `Review pull request #${number} of ${repo} with me in Downstream.`,
    `Downstream is a skill at ${skillDir}: read ${path.join(skillDir, "SKILL.md")} first and follow it.`,
    `Wherever it says \${CLAUDE_SKILL_DIR}, use ${skillDir}. ${start}`,
    "You're running inside Downstream: I read the review and your replies in its margin, so talk to me there and keep `downstream wait` running between turns.",
  ].join(" ");
}

/** For a PR nobody has touched in weeks: a recommendation, with nothing posted. */
export function stalePrompt(item: Item): string {
  const { number, url, role } = item.lead;
  const options = role === "author" ? "ask the reviewers to look, close it, or leave it" : "remove myself as a reviewer, ask the author whether it's still going, review it, or leave it";
  return `Pull request #${number} (${url}) has had no activity for weeks. Read the description, the conversation and the review threads (\`gh pr view ${number} --comments\`, review threads through \`gh api graphql\`) and tell me in a few lines where it stands and whether I should ${options}. Don't post, push or change anything.`;
}

export function promptFor(item: Item, opened: boolean): string | null {
  const make = PROMPTS[item.move.kind];
  return make ? make({ number: item.lead.number, repo: item.lead.repo, url: item.lead.url, opened }) : null;
}
