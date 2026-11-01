import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// src/cli.ts
/**
* True when the module `name` is the script node was started with. Compares real paths (the skill is often
* installed through a symlink) and the file's stem: bundling inlines other CLI modules into one file, where they
* share `import.meta.url` but must not run their own `main`.
*/
function isEntry(moduleUrl, name) {
	const script = process.argv[1];
	if (!script) return false;
	const self = fileURLToPath(moduleUrl);
	return basename(self).replace(/\.[^.]+$/, "") === name && realpathSync(script) === realpathSync(self);
}
// src/git.ts
var GitError = class extends Error {};
let env = {
	...process.env,
	GIT_OPTIONAL_LOCKS: "0"
};
/**
* Runs git in `cwd` and returns stdout. `okCodes` lists the exit codes that count as success
* (`git diff --no-index` exits 1 when the files differ).
*/
function git(cwd, args, okCodes = [0]) {
	const result = spawnSync("git", args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 268435456
	});
	if (result.error) throw new GitError(`git ${args.join(" ")}: ${result.error.message}`);
	if (!okCodes.includes(result.status ?? -1)) throw new GitError(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
	return result.stdout;
}
function tryGit(cwd, args) {
	try {
		return git(cwd, args).trim();
	} catch {
		return null;
	}
}
function repoRootFrom(dir) {
	return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}
// src/run-dir.ts
/** Every run lives under `<repo>/.review-flow/runs/`. */
const RUNS_DIR = join(".review-flow", "runs");
var RunDirError = class extends Error {};
function isInside(child, parent) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/**
* Resolves a run-directory argument and refuses anything outside `<repo>/.review-flow/runs/`.
* Returns the real path of the run directory and of the repo that owns it.
*/
function resolveRunDir(arg) {
	const abs = resolve(arg);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new RunDirError(`run directory not found: ${arg}`);
	const runDir = realpathSync(abs);
	const repoRoot = repoRootFrom(runDir);
	if (!repoRoot || !isInside(runDir, join(realpathSync(repoRoot), RUNS_DIR))) throw new RunDirError(`refusing ${arg}: run directories must be inside <repo>/${RUNS_DIR.split(sep).join("/")}/`);
	return {
		runDir,
		repoRoot: realpathSync(repoRoot)
	};
}
function appendTrace(runDir, entry) {
	appendFileSync(join(runDir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
}
// src/worktree.ts
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
const SCRATCH_DIR = "scratch";
/** Removes one worktree and only its own metadata under `.git/worktrees/`; other worktrees are never pruned. */
function removeWorktree(repoRoot, path) {
	try {
		git(repoRoot, [
			"worktree",
			"remove",
			"--force",
			"--force",
			path
		]);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		rmSync(path, {
			recursive: true,
			force: true
		});
		const admin = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]).trim(), "worktrees");
		for (const name of existsSync(admin) ? readdirSync(admin) : []) {
			let gitdir = "";
			try {
				gitdir = readFileSync(join(admin, name, "gitdir"), "utf8").trim();
			} catch {
				continue;
			}
			if (gitdir === join(path, ".git")) rmSync(join(admin, name), {
				recursive: true,
				force: true
			});
		}
	}
}
/** Every worktree registered under `runDir` (scratch worktrees, later the PR checkout), removed. */
function removeRunWorktrees(runDir, repoRoot) {
	const inRun = git(repoRoot, [
		"worktree",
		"list",
		"--porcelain"
	]).split("\n").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9)).filter((path) => path.startsWith(`${runDir}/`));
	for (const path of inRun) removeWorktree(repoRoot, path);
	rmSync(join(runDir, SCRATCH_DIR), {
		recursive: true,
		force: true
	});
	return inRun;
}
// src/cleanup.ts
/**
* End of stage 6: removes every worktree the run created (scratch worktrees a verifier left behind, later the PR
* checkout) and prunes their git metadata. Every other run file is kept.
*
* Usage: node scripts/dist/cleanup.mjs <runDir>
*
* Prints how many worktrees were removed. Safe to run more than once.
* Exit 0 on success, 2 on usage errors or an unusable run directory.
*/
function cleanup(runDirArg) {
	const startedAt = /* @__PURE__ */ new Date();
	const { runDir, repoRoot } = resolveRunDir(runDirArg);
	const removed = removeRunWorktrees(runDir, repoRoot);
	appendTrace(runDir, {
		step: "cleanup",
		status: "ok",
		started_at: startedAt.toISOString(),
		duration_ms: Date.now() - startedAt.getTime(),
		worktrees_removed: removed.length
	});
	return removed;
}
function main(argv) {
	if (argv.length !== 1) {
		console.error("usage: cleanup.mjs <runDir>");
		return 2;
	}
	try {
		const removed = cleanup(argv[0]);
		console.log(`removed ${removed.length} worktree(s); run files kept`);
		return 0;
	} catch (error) {
		if (!(error instanceof RunDirError)) throw error;
		console.error(error.message);
		return 2;
	}
}
if (isEntry(import.meta.url, "cleanup")) process.exitCode = main(process.argv.slice(2));
export { cleanup, main };
