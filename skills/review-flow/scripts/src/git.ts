import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export class GitError extends Error {}

// GIT_OPTIONAL_LOCKS=0 stops `git status` from rewriting the index; `withPrivateIndex` covers the rest.
let env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/**
 * Runs git in `cwd` and returns stdout. `okCodes` lists the exit codes that count as success
 * (`git diff --no-index` exits 1 when the files differ).
 */
export function git(cwd: string, args: string[], okCodes: number[] = [0]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new GitError(`git ${args.join(" ")}: ${result.error.message}`);
  if (!okCodes.includes(result.status ?? -1))
    throw new GitError(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

export function repoRootFrom(dir: string): string | null {
  return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}

/**
 * Runs `fn` with every `git` call reading a throwaway copy of the repo's index. `git diff` refreshes
 * stale stat info and writes the index back even with GIT_OPTIONAL_LOCKS=0; this keeps the user's index byte-identical.
 */
export function withPrivateIndex<T>(repoRoot: string, fn: () => T): T {
  const index = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-path", "index"]).trim());
  const dir = mkdtempSync(join(tmpdir(), "review-flow-index-"));
  const previous = env;
  try {
    if (existsSync(index)) copyFileSync(index, join(dir, "index"));
    env = { ...previous, GIT_INDEX_FILE: join(dir, "index") };
    return fn();
  } finally {
    env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
