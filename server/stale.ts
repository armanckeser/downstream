// Deciding a stale pull request: each decision does exactly what its label in
// the sweep says, on GitHub and here, and nothing else.
import { z } from "zod";
import { staleChoices, type Item } from "../domain/inbox.ts";
import { ghAsync } from "./gh.ts";

export const StaleDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove-request") }),
  z.object({ kind: z.literal("comment"), body: z.string().trim().min(1) }),
  z.object({ kind: z.literal("close"), reason: z.string().trim().min(1) }),
  z.object({ kind: z.literal("hide") }),
]);
export type StaleDecision = z.infer<typeof StaleDecision>;

/** The decision isn't one this PR offers (closing someone else's PR, removing a request nobody made). */
export class NotOffered extends Error {}

/** GitHub (through gh) said no; its first lines say why. */
export class GitHubRefused extends Error {}

async function write(args: string[], account: string): Promise<void> {
  try {
    await ghAsync(args, { account });
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new GitHubRefused((err.stderr?.toString().trim() || err.message).split("\n").slice(0, 2).join(" "));
  }
}

/**
 * Carry out `decision` on `item` as `account`. GitHub first: if it refuses,
 * nothing is hidden. Hiding comes after, so the PR's own update from the write
 * is older than the hide and doesn't bring it straight back.
 */
export async function decide(account: string, item: Item, decision: StaleDecision, hide: () => void): Promise<void> {
  const offered = staleChoices(item).some((c) => c.kind === decision.kind);
  if (!offered) throw new NotOffered(`#${item.lead.number} doesn't offer "${decision.kind}".`);
  const { repo, number } = item.lead;
  switch (decision.kind) {
    case "remove-request":
      await write(["api", "-X", "DELETE", `repos/${repo}/pulls/${number}/requested_reviewers`, "-f", `reviewers[]=${account}`], account);
      return hide();
    case "comment":
      await write(["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${decision.body}`], account);
      return hide();
    case "close":
      await write(["pr", "close", String(number), "--repo", repo, "--comment", decision.reason], account);
      return;
    case "hide":
      return hide();
  }
}
