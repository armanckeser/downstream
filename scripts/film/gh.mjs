#!/usr/bin/env node
// A stand-in for the GitHub CLI, so the home page can be filmed with a made-up
// inbox instead of a real account's pull requests. It answers only the calls
// Downstream's server makes (server/gh.ts, server/github.ts); anything else
// fails the way a missing gh would. Put scripts/film/bin first on PATH to use it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ACCOUNT = "jordan-lee";
const HOUR = 3600_000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

const PALETTE = ["#7c6f64", "#5f7f8f", "#8f6f5f", "#6f8f6a", "#7f6a8f", "#8f8a5f"];
function avatar(login) {
  const initials = login.split("-").map((w) => w[0].toUpperCase()).join("").slice(0, 2);
  const fill = PALETTE[[...login].reduce((sum, c) => sum + c.charCodeAt(0), 0) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${fill}"/><text x="24" y="30" font-family="Helvetica,Arial" font-size="18" font-weight="600" fill="#f2efe8" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const PEOPLE = {
  "jordan-lee": "Jordan Lee",
  "priya-shah": "Priya Shah",
  "sam-okafor": "Sam Okafor",
  "marco-diaz": "Marco Diaz",
  "lena-park": "Lena Park",
  "ines-moreau": "Inès Moreau",
};

let sha = 0;
function pr({ repo, number, title, author, hours, decision = "REVIEW_REQUIRED", checks = "SUCCESS", mergeable = "MERGEABLE", threads = 0, reviews = [], timeline = [], draft = false }) {
  return {
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    updatedAt: ago(hours),
    isDraft: draft,
    repository: { nameWithOwner: repo },
    baseRefName: "main",
    headRefName: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, ""),
    headRefOid: (++sha).toString(16).padStart(40, "a"),
    reviewDecision: decision,
    mergeable,
    author: { __typename: "User", login: author, avatarUrl: avatar(author), name: PEOPLE[author] },
    stack: null,
    stackEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks } : null } }] },
    reviewThreads: { nodes: Array.from({ length: threads }, () => ({ isResolved: false })) },
    latestReviews: { nodes: reviews.map(([login, state, h]) => ({ author: { login }, state, submittedAt: ago(h) })) },
    timelineItems: { nodes: timeline },
  };
}

const REQUESTED = [
  pr({ repo: "acme/storefront", number: 482, title: "Discount codes at checkout", author: "priya-shah", hours: 0.4 }),
  pr({ repo: "acme/payments", number: 1203, title: "Retry failed webhooks with backoff", author: "sam-okafor", hours: 5 }),
  pr({ repo: "acme/mobile-app", number: 77, title: "Offline cart sync", author: "lena-park", hours: 30 }),
];

const REVIEWED = [
  pr({
    repo: "acme/storefront", number: 476, title: "Paginate search results on the server", author: "marco-diaz", hours: 3,
    decision: "CHANGES_REQUESTED", reviews: [[ACCOUNT, "CHANGES_REQUESTED", 50]],
    timeline: [
      { __typename: "PullRequestReview", submittedAt: ago(50), state: "CHANGES_REQUESTED", author: { login: ACCOUNT } },
      { __typename: "PullRequestCommit", commit: { committedDate: ago(3) } },
    ],
  }),
  pr({
    repo: "acme/payments", number: 1190, title: "Move invoices to the new ledger", author: "sam-okafor", hours: 20,
    decision: "APPROVED", reviews: [[ACCOUNT, "APPROVED", 20]],
    timeline: [{ __typename: "PullRequestReview", submittedAt: ago(20), state: "APPROVED", author: { login: ACCOUNT } }],
  }),
];

const MINE = [
  pr({ repo: "acme/storefront", number: 479, title: "Cache product images at the edge", author: ACCOUNT, hours: 2, decision: "APPROVED", reviews: [["ines-moreau", "APPROVED", 2]] }),
  pr({ repo: "acme/design-system", number: 318, title: "Button sizes follow the type scale", author: ACCOUNT, hours: 6, decision: "CHANGES_REQUESTED", threads: 3, reviews: [["lena-park", "CHANGES_REQUESTED", 6]] }),
  pr({ repo: "acme/payments", number: 1199, title: "Round refunds in the customer's currency", author: ACCOUNT, hours: 1, checks: "FAILURE" }),
  pr({ repo: "acme/mobile-app", number: 71, title: "Deep links open the right tab", author: ACCOUNT, hours: 26, mergeable: "CONFLICTING", decision: "APPROVED", reviews: [["priya-shah", "APPROVED", 26]] }),
  pr({ repo: "acme/storefront", number: 481, title: "Gift cards at checkout", author: ACCOUNT, hours: 8 }),
];

const ALL = [...REQUESTED, ...REVIEWED, ...MINE];

const BODIES = {
  482: "Customers can enter a discount code at checkout. Codes are either a percentage or a fixed amount, and come off before tax.\n\nCodes live in `src/pricing/codes.ts` for now; moving them to the admin is a follow-up.",
};

const FILES = {
  482: [
    { path: "src/pricing/discount.ts", additions: 17, deletions: 0, changeType: "ADDED" },
    { path: "src/pricing/codes.ts", additions: 6, deletions: 0, changeType: "ADDED" },
    { path: "src/pricing/price-cart.ts", additions: 6, deletions: 3, changeType: "MODIFIED" },
    { path: "src/pricing/types.ts", additions: 6, deletions: 1, changeType: "MODIFIED" },
    { path: "src/routes/checkout.ts", additions: 3, deletions: 3, changeType: "MODIFIED" },
  ],
};

function detail(owner, name, number) {
  const node = ALL.find((p) => p.repository.nameWithOwner === `${owner}/${name}` && p.number === Number(number));
  if (!node) return null;
  return {
    body: BODIES[node.number] ?? "",
    additions: 38,
    deletions: 7,
    changedFiles: 5,
    createdAt: ago(30),
    commitCount: { totalCount: 2 },
    files: { nodes: FILES[node.number] ?? [] },
    latestReviews: { nodes: node.latestReviews.nodes.map((r) => ({ author: { login: r.author.login, avatarUrl: avatar(r.author.login), name: PEOPLE[r.author.login] }, state: r.state })) },
    reviewRequests: { nodes: node.author.login === ACCOUNT ? [] : [{ requestedReviewer: { __typename: "User", login: ACCOUNT, name: PEOPLE[ACCOUNT], avatarUrl: avatar(ACCOUNT) } }] },
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "test", conclusion: node.commits.nodes[0].commit.statusCheckRollup?.state ?? "SUCCESS", status: "COMPLETED" }] } } } }] },
  };
}

const args = process.argv.slice(2);
const field = (name) => {
  const i = args.findIndex((a, at) => (args[at - 1] === "-f" || args[at - 1] === "-F") && a.startsWith(`${name}=`));
  return i === -1 ? null : args[i].slice(name.length + 1);
};
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));

/** The fictional pull request's head, from the repository stage.sh made. */
const headSha = () => execFileSync("git", ["-C", process.env.DOWNSTREAM_FILM_REPO ?? ".", "rev-parse", "discount-codes"], { encoding: "utf8" }).trim();

function answer() {
  const [command, sub] = args;
  if (command === "pr" && sub === "view") {
    const info = { baseRefName: "main", headRefOid: headSha(), title: "Discount codes at checkout" };
    return out(args.includes("--jq") ? `${info.headRefOid}\n` : info);
  }
  if (command === "api" && args.includes("POST") && args.some((a) => /pulls\/\d+\/reviews$/.test(a))) {
    readFileSync(0);
    return out({ html_url: "https://github.com/acme/storefront/pull/482#pullrequestreview-1" });
  }
  if (command === "auth" && sub === "status") return out({ hosts: { "github.com": [{ login: ACCOUNT, active: true, state: "success" }] } });
  if (command === "auth" && sub === "token") return out("film-token\n");
  if (command !== "api") return null;
  if (sub === "user") return out(`${avatar(ACCOUNT)}\n`);
  // A review of Priya's last PR yesterday makes her a teammate you're working with.
  if (sub.startsWith("/users/")) return out([[{ type: "PullRequestReviewEvent", created_at: ago(20), repo: { name: "acme/storefront" }, payload: { pull_request: { number: 470 } } }]]);
  if (sub !== "graphql") return null;
  const q = field("q");
  if (q?.includes("user-review-requested")) return out({ data: { search: { nodes: REQUESTED } } });
  if (q?.includes("reviewed-by")) return out({ data: { search: { nodes: REVIEWED } } });
  if (q?.includes("author:@me")) return out({ data: { search: { nodes: MINE } } });
  const owner = field("owner");
  if (owner) {
    const found = detail(owner, field("name"), field("number"));
    return found ? out({ data: { repository: { pullRequest: found } } }) : null;
  }
  const query = field("query") ?? "";
  if (query.includes("p0: repository")) return out({ data: { p0: { pullRequest: { author: { login: "priya-shah" } } } } });
  return out({ data: {} });
}

if (answer() === null) {
  process.stderr.write(`gh (film stand-in): ${args.join(" ")} is not filmed\n`);
  process.exit(1);
}
