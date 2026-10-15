// Every GitHub CLI call goes through here, so each one runs as the account it
// belongs to. People with a work and a personal account have both logged in to
// gh; the active one flips, so nothing may rely on it.
import { execFileSync, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

/**
 * Always from a neutral directory, with the repository passed as `--repo`:
 * directory-aware gh wrappers pick an account from the working directory and
 * would override the token we set.
 */
const NEUTRAL = tmpdir();

const run = promisify(execFile);
const tokens = new Map<string, string>();

/** `gh auth token --user <login>`: the account's own token, whichever account is active. */
export function tokenFor(account: string): string {
  let token = tokens.get(account);
  if (!token) {
    token = execFileSync("gh", ["auth", "token", "--user", account], { cwd: NEUTRAL, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    tokens.set(account, token);
  }
  return token;
}

export function ghEnv(account: string | null): NodeJS.ProcessEnv {
  return account ? { ...process.env, GH_TOKEN: tokenFor(account) } : process.env;
}

export function gh(args: string[], opts: { account?: string | null; input?: string } = {}): string {
  return execFileSync("gh", args, {
    cwd: NEUTRAL,
    env: ghEnv(opts.account ?? null),
    input: opts.input,
    encoding: "utf8",
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export async function ghAsync(args: string[], opts: { account?: string | null } = {}): Promise<string> {
  const { stdout } = await run("gh", args, { cwd: NEUTRAL, env: ghEnv(opts.account ?? null), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The github.com accounts gh is logged in to, active one first. */
export function accounts(): string[] {
  try {
    const out = JSON.parse(gh(["auth", "status", "--json", "hosts"])) as { hosts: Record<string, { login: string; active: boolean; state: string }[]> };
    const list = (out.hosts["github.com"] ?? []).filter((a) => a.state === "success");
    return [...list].sort((a, b) => Number(b.active) - Number(a.active)).map((a) => a.login);
  } catch {
    return [];
  }
}
