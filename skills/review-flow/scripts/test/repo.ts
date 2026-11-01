import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const NO_USER_CONFIG = join(tmpdir(), "review-flow-no-user-config.json");

export function sh(cwd: string, ...args: string[]): string {
  // GIT_OPTIONAL_LOCKS=0: the snapshot's own `git status` must not refresh the index it is hashing.
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

export function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repo on `main` with one commit, then a `feature` branch with a commit and every kind of uncommitted change. */
export function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-flow-prepare-")));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "Test");
  write(root, "package.json", JSON.stringify({ devDependencies: { typescript: "5", vitest: "3" } }));
  write(root, "src/cart.ts", 'import { tax } from "./tax.js";\nexport const total = (n: number) => n + tax(n);\n');
  write(root, "src/tax.ts", "export const tax = (n: number) => n * 0.2;\n");
  write(root, "src/old.ts", "export {};\n");
  write(root, "test/cart.test.ts", "// tests\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "init");
  sh(root, "checkout", "-q", "-b", "feature");
  write(root, "src/committed.ts", "export const committed = 1;\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "feature work");
  write(root, "src/tax.ts", "export const tax = (n: number) => n * 0.25;\n"); // staged
  sh(root, "add", "src/tax.ts");
  write(root, "src/cart.ts", 'import { tax } from "./tax.js";\nexport const total = (n: number) => n + tax(n) + 1;\n'); // unstaged
  sh(root, "rm", "-q", "src/old.ts");
  write(root, "src/new file.ts", "export const fresh = true;\n"); // untracked, with a space
  return root;
}

/** Everything §11.3 says must be byte-identical: working tree status, index, branch, stash. */
export function snapshot(root: string) {
  return {
    status: sh(root, "status", "--porcelain=v2", "--untracked-files=all"),
    index: createHash("sha256")
      .update(readFileSync(join(root, ".git/index")))
      .digest("hex"),
    branch: sh(root, "symbolic-ref", "HEAD"),
    head: sh(root, "rev-parse", "HEAD"),
    stash: sh(root, "stash", "list"),
    worktrees: sh(root, "worktree", "list", "--porcelain"),
  };
}
