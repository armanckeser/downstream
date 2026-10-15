// What the agent may do without asking. A wrong "allow" here means the agent
// changes or publishes something you never saw; a wrong "ask" only costs a click.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoApprove, reachesOthers } from "./approval.ts";

const SKILL = "/Users/abed/downstream";
const bash = (command: string) => autoApprove("Bash", { command }, SKILL).allow;

const allowed: [string, string][] = [
  ["the Downstream CLI by path", `node ${SKILL}/bin/downstream.mjs show`],
  ["downstream wait with a timeout", `node "${SKILL}/bin/downstream.mjs" wait --timeout 600`],
  ["reading code with line ranges", "sed -n 10,40p server/main.ts"],
  ["a search piped into head", "rg -n 'pickNow' src | head -20"],
  ["git history in another directory", "git -C /tmp/repo log --oneline -5"],
  ["the PR's checks", "gh pr checks 42"],
  ["a GraphQL query", `gh api graphql -f query='query { viewer { login } }'`],
  ["stderr folded into stdout", "git diff main...HEAD 2>&1 | head"],
  ["gh called through a wrapper path", "~/.local/bin/gh pr view 2 --json title,body 2>&1 | head -200"],
  ["a loop over files git lists", `for f in $(git ls-tree --name-only HEAD drafts/); do head -3 "$f"; done | sort | uniq -c`],
  ["counting lines of what git lists", "wc -l $(git ls-files '*.ts')"],
  ["reading what git lists line by line", `git ls-files | while read f; do wc -l "$f"; done`],
];

for (const [name, command] of allowed) {
  test(`autoApprove allows ${name}`, () => assert.equal(bash(command), true));
}

const asked: [string, string][] = [
  // Regression guarded: sending the review is public and permanent; the agent may only do it when you say so.
  ["sending the review", `node ${SKILL}/bin/downstream.mjs send`],
  ["publishing through the generic action", `node ${SKILL}/bin/downstream.mjs do review.publish '{}'`],
  // Regression guarded: a read command chained to a write would ride through on the read's approval.
  ["a push chained after a read", "git status && git push --force"],
  ["writing a file through a redirect", "cat a > b"],
  ["a command substitution", "echo $(rm -rf ~)"],
  ["a write inside a loop", "for f in a b; do rm $f; done"],
  ["a program named by a substitution", "$(echo git) push"],
  // Regression guarded: expanded text is unseen, so `git show $f` with f = `x --output=~/.zshrc` would write a file.
  ["an expanded argument to git", "for f in $(git ls-files); do git show HEAD:$f; done"],
  ["flags smuggled into gh api by a substitution", "gh api $(echo -X POST) repos/greendale/study-room/pulls/1/reviews"],
  ["flags smuggled into rg by a substitution", "rg $(cat flags.txt) foo"],
  ["the Downstream CLI with an expanded subcommand", `node ${SKILL}/bin/downstream.mjs $NEXT`],
  ["an unclosed substitution", "cat $(git ls-files"],
  ["an in-place edit", "sed -i '' 's/a/b/' x.ts"],
  ["rg running a preprocessor", "rg --pre ./evil.sh foo"],
  ["fd running a command per file", "fd -e ts -x rm"],
  ["find deleting", "find . -name '*.log' -delete"],
  ["git writing a diff to a file", "git diff --output=/tmp/x"],
  ["deleting a branch", "git branch -D feature"],
  ["a GraphQL mutation", `gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`],
  ["a REST POST", "gh api -X POST repos/greendale/study-room/pulls/1/reviews"],
  ["merging a PR", "gh pr merge 42"],
  ["merging through a wrapper path", "~/.local/bin/gh pr merge 42"],
  ["a look-alike script named after gh", "./gh-merge-everything"],
  ["an unknown program", "npm install left-pad"],
  ["a shell builtin from the prototype", "constructor"],
];

for (const [name, command] of asked) {
  test(`autoApprove asks before ${name}`, () => assert.equal(bash(command), false));
}

test("autoApprove allows reading a file", () => {
  assert.deepEqual(autoApprove("Read", { file_path: "/tmp/x" }, SKILL), { allow: true });
});

test("autoApprove asks before editing a file", () => {
  assert.equal(autoApprove("Edit", { file_path: "/tmp/x" }, SKILL).allow, false);
});

// What still comes to you in auto mode. A miss here means the agent posts,
// merges or pushes in your name without you seeing it first.
const outward: [string, string][] = [
  ["sending the review", `node ${SKILL}/bin/downstream.mjs send`],
  ["publishing through the generic action", `node ${SKILL}/bin/downstream.mjs do review.publish '{}'`],
  ["a push", "git push origin HEAD"],
  ["a push in another directory", "git -C /tmp/study-room push --force"],
  ["a push hidden after a read", "git status && git push"],
  ["a push inside a substitution", "echo $(git push)"],
  ["a review on GitHub", "gh pr review 42 --approve"],
  ["a merge through a wrapper path", "~/.local/bin/gh pr merge 42 --squash"],
  ["a PR comment", "gh pr comment 42 --body 'streets ahead'"],
  ["a REST POST", "gh api -X POST repos/greendale/study-room/pulls/1/reviews"],
  ["a REST write with --method=PATCH", "gh api --method=PATCH repos/greendale/study-room/pulls/1"],
  ["fields that make gh api POST", "gh api repos/greendale/study-room/issues/1/comments -f body=hi"],
  ["a GraphQL mutation", `gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`],
];

for (const [name, command] of outward) {
  test(`reachesOthers stops ${name}`, () => assert.notEqual(reachesOthers("Bash", { command }), null));
}

const inward: [string, string][] = [
  ["reading the PR", "~/.local/bin/gh pr view 42 --json title,body"],
  ["a GraphQL query with fields", `gh api graphql -f query='query { viewer { login } }'`],
  ["a GET with fields", "gh api -X GET search/issues -f q=paintball"],
  ["a commit", "git commit -m 'Add the paintball rules'"],
  ["the Downstream wait", `node ${SKILL}/bin/downstream.mjs wait --timeout 600`],
  ["running the tests", "npm test"],
];

for (const [name, command] of inward) {
  test(`reachesOthers lets ${name} through`, () => assert.equal(reachesOthers("Bash", { command }), null));
}

test("reachesOthers ignores tools other than Bash", () => {
  assert.equal(reachesOthers("Edit", { file_path: "/tmp/x" }), null);
});
