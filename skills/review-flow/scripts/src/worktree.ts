/**
 * Worktrees a run creates inside its run directory: scratch worktrees for verifiers (`scratch/<id>/`), and later the
 * PR checkout. Shared by `scratch.mjs` and `cleanup.mjs`.
 *
 * A scratch worktree reproduces the reviewed code. In `current` mode that is `target.head_sha` plus the working
 * tree's changes against it (tracked edits via `git apply`, untracked files copied), so it matches `code_root` even
 * if the user committed since prepare. Ignored `node_modules` directories are mirrored as per-package symlinks into
 * the user's checkout (see `mirrorNodeModules`); nothing is installed. Hooks are disabled for the checkout.
 *
 * Never touches the user's working tree, index, branches or stash: the only shared state is the worktree entry
 * under `.git/worktrees/`, which removal takes away again.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Context, readContext } from "./context.js";
import { git, GitError, withPrivateIndex } from "./git.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";

export class ScratchError extends Error {}

export const SCRATCH_DIR = "scratch";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Run files never belong in a scratch copy (they would also include the scratch worktrees themselves).
const NOT_RUN_FILES = ["--", ".", ":(exclude).review-flow"];

export type Scratch = { path: string; copied: number; nodeModules: string[] };

/** The worktree path for a candidate; refuses ids that aren't candidates of this run. */
export function scratchPath(runDir: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new RunDirError(`invalid candidate id "${id}"`);
  if (!existsSync(join(runDir, "candidates", `${id}.json`)))
    throw new RunDirError(`no candidate ${id} in ${join(runDir, "candidates")}: run dedup.mjs first`);
  return join(runDir, SCRATCH_DIR, id);
}

function readRunContext(runDir: string): Context {
  try {
    return readContext(runDir);
  } catch (error) {
    throw new RunDirError(`cannot read ${join(runDir, "context.json")}: ${(error as Error).message}`);
  }
}

/** Working tree vs. `sha` for tracked files (binary-safe, for `git apply`), and the untracked files. */
function workingChanges(repoRoot: string, sha: string): { patch: string; untracked: string[] } {
  // A private index, because `git diff` would otherwise refresh and rewrite the user's.
  return withPrivateIndex(repoRoot, () => ({
    patch: git(repoRoot, [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules",
      // A user's diff.context=0 would leave hunks `git apply` can't place.
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      sha,
      ...NOT_RUN_FILES,
    ]),
    untracked: git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...NOT_RUN_FILES])
      .split("\0")
      .filter(Boolean),
  }));
}

/** Ignored `node_modules` directories of the user's checkout, e.g. `node_modules/`, `packages/app/node_modules/`. */
function nodeModulesDirs(repoRoot: string): string[] {
  return git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
    ...NOT_RUN_FILES,
  ])
    .split("\0")
    .filter((path) => /(^|\/)node_modules\/$/.test(path))
    .map((path) => path.slice(0, -1))
    .toSorted();
}

/** Copies a regular file (keeping its mode) or recreates a symlink; anything else is skipped. */
function copyEntry(from: string, to: string): boolean {
  let stat;
  try {
    stat = lstatSync(from);
  } catch {
    return false; // deleted since it was listed
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) return false;
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { force: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else {
    copyFileSync(from, to);
    chmodSync(to, stat.mode & 0o777);
  }
  return true;
}

// Caches tools write into node_modules itself (vite/vitest, babel-loader, eslint, …): left out of the mirror, so a
// verifier's runs write their own cache in the scratch tree instead of the user's.
const NODE_MODULES_CACHES = new Set([".cache", ".vite", ".vitest"]);

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Mirrors `<repoRoot>/<dir>` into the scratch tree as a real directory of per-entry symlinks, so writes to the
 * directory itself (tool caches) stay in scratch. Scope directories (`@org/`) are mirrored one level deeper.
 * Symlinked entries that resolve inside the repo (workspace packages, `.bin`, pnpm's `.pnpm`) point at the same path
 * in the scratch tree, so code a verifier edits there is the code that runs. Writes into a package directory still
 * reach the user's copy.
 */
function mirrorNodeModules(repoRoot: string, scratchRoot: string, dir: string): void {
  const from = join(repoRoot, dir);
  const to = join(scratchRoot, dir);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (NODE_MODULES_CACHES.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = resolve(from, readlinkSync(source));
      symlinkSync(isInside(resolved, repoRoot) ? join(scratchRoot, relative(repoRoot, resolved)) : resolved, target);
    } else if (entry.isDirectory() && entry.name.startsWith("@"))
      mirrorNodeModules(repoRoot, scratchRoot, join(dir, entry.name));
    else symlinkSync(source, target);
  }
}

/** Removes one worktree and only its own metadata under `.git/worktrees/`; other worktrees are never pruned. */
function removeWorktree(repoRoot: string, path: string): void {
  try {
    // Also drops the registration of a worktree whose directory is already gone.
    git(repoRoot, ["worktree", "remove", "--force", "--force", path]);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    // Not a valid registered worktree (half-created, or its .git file deleted): delete the files, then any admin
    // entry that still points at it.
    rmSync(path, { recursive: true, force: true });
    const admin = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]).trim(), "worktrees");
    for (const name of existsSync(admin) ? readdirSync(admin) : []) {
      let gitdir = "";
      try {
        gitdir = readFileSync(join(admin, name, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      if (gitdir === join(path, ".git")) rmSync(join(admin, name), { recursive: true, force: true });
    }
  }
}

export function createScratch(runDirArg: string, id: string): Scratch {
  const startedAt = new Date();
  const { runDir, repoRoot } = resolveRunDir(runDirArg);
  const path = scratchPath(runDir, id);
  const context = readRunContext(runDir);
  if (!context.limits.allowExecution)
    throw new ScratchError(`execution is disabled for preset "${context.preset}"; verify without running code`);
  if (context.target.mode !== "current")
    throw new ScratchError(`scratch worktrees for "${context.target.mode}" mode are not supported yet`);

  // Unconditionally: a scratch directory may be gone while its worktree is still registered.
  removeWorktree(repoRoot, path);
  mkdirSync(dirname(path), { recursive: true });
  const sha = context.target.head_sha;
  try {
    // Not under the private index: GIT_INDEX_FILE would redirect the new worktree's own index.
    git(repoRoot, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", path, sha]);
    const { patch, untracked } = workingChanges(repoRoot, sha);
    if (patch) {
      const patchFile = join(runDir, SCRATCH_DIR, `${id}.patch`);
      writeFileSync(patchFile, patch);
      try {
        git(path, ["apply", "--whitespace=nowarn", patchFile]);
      } finally {
        rmSync(patchFile, { force: true });
      }
    }
    const copied = untracked.filter((file) => copyEntry(join(repoRoot, file), join(path, file))).length;
    const nodeModules = nodeModulesDirs(repoRoot).filter((dir) => {
      if (existsSync(join(path, dir))) return false; // tracked or copied content wins
      mirrorNodeModules(repoRoot, path, dir);
      return true;
    });
    const scratch = { path, copied, nodeModules };
    appendTrace(runDir, {
      step: "scratch-create",
      status: "ok",
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      candidate_id: id,
      untracked_copied: copied,
      node_modules: nodeModules.length,
    });
    return scratch;
  } catch (error) {
    removeWorktree(repoRoot, path);
    appendTrace(runDir, {
      step: "scratch-create",
      status: "error",
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      candidate_id: id,
      error: (error as Error).message,
    });
    if (error instanceof GitError) throw new ScratchError(`cannot create the scratch worktree: ${error.message}`);
    throw error;
  }
}

export function removeScratch(runDirArg: string, id: string): boolean {
  const startedAt = new Date();
  const { runDir, repoRoot } = resolveRunDir(runDirArg);
  const path = scratchPath(runDir, id);
  const existed = existsSync(path);
  removeWorktree(repoRoot, path);
  appendTrace(runDir, {
    step: "scratch-remove",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    candidate_id: id,
    existed,
  });
  return existed;
}

/** Every worktree registered under `runDir` (scratch worktrees, later the PR checkout), removed. */
export function removeRunWorktrees(runDir: string, repoRoot: string): string[] {
  const inRun = git(repoRoot, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
    .filter((path) => path.startsWith(`${runDir}/`));
  for (const path of inRun) removeWorktree(repoRoot, path);
  rmSync(join(runDir, SCRATCH_DIR), { recursive: true, force: true });
  return inRun;
}
