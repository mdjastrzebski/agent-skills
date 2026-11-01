import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
/**
* Runs `fn` with every `git` call reading a throwaway copy of the repo's index. `git diff` refreshes
* stale stat info and writes the index back even with GIT_OPTIONAL_LOCKS=0; this keeps the user's index byte-identical.
*/
function withPrivateIndex(repoRoot, fn) {
	const index = resolve(repoRoot, git(repoRoot, [
		"rev-parse",
		"--git-path",
		"index"
	]).trim());
	const dir = mkdtempSync(join(tmpdir(), "review-flow-index-"));
	const previous = env;
	try {
		if (existsSync(index)) copyFileSync(index, join(dir, "index"));
		env = {
			...previous,
			GIT_INDEX_FILE: join(dir, "index")
		};
		return fn();
	} finally {
		env = previous;
		rmSync(dir, {
			recursive: true,
			force: true
		});
	}
}
// src/run-dir.ts
/** Every run lives under `<repo>/.review-flow/runs/`. */
const RUNS_DIR = join(".review-flow", "runs");
var RunDirError = class extends Error {};
function isInside$1(child, parent) {
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
	if (!repoRoot || !isInside$1(runDir, join(realpathSync(repoRoot), RUNS_DIR))) throw new RunDirError(`refusing ${arg}: run directories must be inside <repo>/${RUNS_DIR.split(sep).join("/")}/`);
	return {
		runDir,
		repoRoot: realpathSync(repoRoot)
	};
}
function appendTrace(runDir, entry) {
	appendFileSync(join(runDir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
}
// src/context.ts
function readContext(runDir) {
	return JSON.parse(readFileSync(join(runDir, "context.json"), "utf8"));
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
var ScratchError = class extends Error {};
const SCRATCH_DIR = "scratch";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOT_RUN_FILES = [
	"--",
	".",
	":(exclude).review-flow"
];
/** The worktree path for a candidate; refuses ids that aren't candidates of this run. */
function scratchPath(runDir, id) {
	if (!ID_PATTERN.test(id)) throw new RunDirError(`invalid candidate id "${id}"`);
	if (!existsSync(join(runDir, "candidates", `${id}.json`))) throw new RunDirError(`no candidate ${id} in ${join(runDir, "candidates")}: run dedup.mjs first`);
	return join(runDir, SCRATCH_DIR, id);
}
function readRunContext(runDir) {
	try {
		return readContext(runDir);
	} catch (error) {
		throw new RunDirError(`cannot read ${join(runDir, "context.json")}: ${error.message}`);
	}
}
/** Working tree vs. `sha` for tracked files (binary-safe, for `git apply`), and the untracked files. */
function workingChanges(repoRoot, sha) {
	return withPrivateIndex(repoRoot, () => ({
		patch: git(repoRoot, [
			"diff",
			"--binary",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--ignore-submodules",
			"--unified=3",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			sha,
			...NOT_RUN_FILES
		]),
		untracked: git(repoRoot, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
			...NOT_RUN_FILES
		]).split("\0").filter(Boolean)
	}));
}
/** Ignored `node_modules` directories of the user's checkout, e.g. `node_modules/`, `packages/app/node_modules/`. */
function nodeModulesDirs(repoRoot) {
	return git(repoRoot, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--directory",
		"-z",
		...NOT_RUN_FILES
	]).split("\0").filter((path) => /(^|\/)node_modules\/$/.test(path)).map((path) => path.slice(0, -1)).toSorted();
}
/** Copies a regular file (keeping its mode) or recreates a symlink; anything else is skipped. */
function copyEntry(from, to) {
	let stat;
	try {
		stat = lstatSync(from);
	} catch {
		return false;
	}
	if (!stat.isFile() && !stat.isSymbolicLink()) return false;
	mkdirSync(dirname(to), { recursive: true });
	rmSync(to, { force: true });
	if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
	else {
		copyFileSync(from, to);
		chmodSync(to, stat.mode & 511);
	}
	return true;
}
const NODE_MODULES_CACHES = /* @__PURE__ */ new Set([
	".cache",
	".vite",
	".vitest"
]);
function isInside(child, parent) {
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
function mirrorNodeModules(repoRoot, scratchRoot, dir) {
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
		} else if (entry.isDirectory() && entry.name.startsWith("@")) mirrorNodeModules(repoRoot, scratchRoot, join(dir, entry.name));
		else symlinkSync(source, target);
	}
}
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
function createScratch(runDirArg, id) {
	const startedAt = /* @__PURE__ */ new Date();
	const { runDir, repoRoot } = resolveRunDir(runDirArg);
	const path = scratchPath(runDir, id);
	const context = readRunContext(runDir);
	if (!context.limits.allowExecution) throw new ScratchError(`execution is disabled for preset "${context.preset}"; verify without running code`);
	if (context.target.mode !== "current") throw new ScratchError(`scratch worktrees for "${context.target.mode}" mode are not supported yet`);
	removeWorktree(repoRoot, path);
	mkdirSync(dirname(path), { recursive: true });
	const sha = context.target.head_sha;
	try {
		git(repoRoot, [
			"-c",
			"core.hooksPath=/dev/null",
			"worktree",
			"add",
			"--detach",
			"--quiet",
			path,
			sha
		]);
		const { patch, untracked } = workingChanges(repoRoot, sha);
		if (patch) {
			const patchFile = join(runDir, SCRATCH_DIR, `${id}.patch`);
			writeFileSync(patchFile, patch);
			try {
				git(path, [
					"apply",
					"--whitespace=nowarn",
					patchFile
				]);
			} finally {
				rmSync(patchFile, { force: true });
			}
		}
		const copied = untracked.filter((file) => copyEntry(join(repoRoot, file), join(path, file))).length;
		const nodeModules = nodeModulesDirs(repoRoot).filter((dir) => {
			if (existsSync(join(path, dir))) return false;
			mirrorNodeModules(repoRoot, path, dir);
			return true;
		});
		const scratch = {
			path,
			copied,
			nodeModules
		};
		appendTrace(runDir, {
			step: "scratch-create",
			status: "ok",
			started_at: startedAt.toISOString(),
			duration_ms: Date.now() - startedAt.getTime(),
			candidate_id: id,
			untracked_copied: copied,
			node_modules: nodeModules.length
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
			error: error.message
		});
		if (error instanceof GitError) throw new ScratchError(`cannot create the scratch worktree: ${error.message}`);
		throw error;
	}
}
function removeScratch(runDirArg, id) {
	const startedAt = /* @__PURE__ */ new Date();
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
		existed
	});
	return existed;
}
// src/scratch.ts
/**
* Stage 4 helper: throwaway worktrees where a verifier may write repros and run the check commands.
*
* Usage: node scripts/dist/scratch.mjs create <runDir> <candidateId>
*        node scripts/dist/scratch.mjs remove <runDir> <candidateId>
*
* `create` adds a detached worktree at `<runDir>/scratch/<id>/` that reproduces the reviewed code (see worktree.ts),
* replacing an existing one for the id. Prints a summary, then the worktree path as the last line of stdout.
* `remove` deletes the worktree and its git metadata, whatever the verifier left in it.
* Exit 0 on success, 1 when the worktree can't be created (execution disabled, git failure), 2 on usage errors.
*/
const USAGE = "usage: scratch.mjs create|remove <runDir> <candidateId>";
function main(argv) {
	const [command, runDir, id] = argv;
	if (argv.length !== 3 || command !== "create" && command !== "remove") {
		console.error(USAGE);
		return 2;
	}
	try {
		if (command === "remove") {
			console.log(removeScratch(runDir, id) ? `removed scratch worktree for ${id}` : `no scratch worktree for ${id}`);
			return 0;
		}
		const scratch = createScratch(runDir, id);
		console.log(`scratch worktree for ${id}: HEAD + uncommitted changes (${scratch.copied} untracked file(s) copied)`);
		console.log(scratch.nodeModules.length ? `node_modules packages linked from the user's checkout (don't modify them): ${scratch.nodeModules.join(", ")}` : "no node_modules in the user's checkout: dependencies are unavailable, so don't execute (remove this worktree)");
		console.log(scratch.path);
		return 0;
	} catch (error) {
		if (error instanceof RunDirError) {
			console.error(error.message);
			return 2;
		}
		if (error instanceof ScratchError) {
			console.error(error.message);
			return 1;
		}
		throw error;
	}
}
if (isEntry(import.meta.url, "scratch")) process.exitCode = main(process.argv.slice(2));
export { main };
