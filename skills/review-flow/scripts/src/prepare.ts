/**
 * Stage 1: create a run directory with `context.json` and `diff.patch` for the reviewers.
 *
 * Usage: node scripts/dist/prepare.mjs [--target current] [--base <ref>] [--rigor low|medium|high]
 *                                      [--lenses a,b] [--harness claude] [--set key=value]... [--repo <dir>]
 *
 * Only `current` mode exists so far: the working tree (committed, staged, unstaged and untracked changes)
 * against its merge-base with `base`. `--base HEAD` reviews just the uncommitted changes.
 * Read-only towards the user's checkout: no checkout, stash, reset, or index refresh.
 *
 * Prints a short summary, then the run directory as the last line of stdout.
 * Exit 0 on success, 1 on config/git errors or when there is nothing to review, 2 on usage errors.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isEntry } from "./cli.js";
import { BUILTIN_LENSES } from "./config-schema.js";
import { ConfigError, loadConfig, skillDir } from "./config.js";
import { type Context, detectSpecs, fileContext, type Lens } from "./context.js";
import { detectBase, detectChecks, detectStack } from "./detect.js";
import { parseDiff } from "./diff.js";
import { git, GitError, repoRootFrom, tryGit, withPrivateIndex } from "./git.js";
import { appendTrace, createRunDir, ensureExcluded } from "./run-dir.js";

export class PrepareError extends Error {}

export type PrepareOptions = {
  repoRoot: string;
  target?: string;
  base?: string;
  rigor?: string;
  lenses?: string[];
  harness?: string;
  sets?: string[];
  userConfigPath?: string;
  now?: Date;
};

/** Pathspec for "everything except ignored globs and our own run files". */
function pathspec(ignore: string[]): string[] {
  return ["--", ".", ":(exclude).review-flow", ...ignore.map((glob) => `:(exclude,glob)${glob}`)];
}

/** A bare branch name prefers its remote-tracking ref, which is what the PR will be compared against. */
function resolveBaseRef(repoRoot: string, base: string): string {
  if (base !== "HEAD" && !base.includes("/")) {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]) !== null)
        return ref.replace(/^refs\/(heads|remotes)\//, "");
    }
  }
  if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null)
    throw new PrepareError(`base "${base}" is not a commit in this repo; pass --base <ref>`);
  return base;
}

function untrackedFiles(repoRoot: string, ignore: string[]): string[] {
  return git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec(ignore)])
    .split("\0")
    .filter(Boolean)
    .toSorted();
}

/** Working tree vs. merge-base (tracked files), then untracked files as additions. */
function currentDiff(repoRoot: string, mergeBase: string, ignore: string[]): string {
  const diffArgs = [
    "-c",
    "core.quotepath=off",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  let patch = git(repoRoot, [...diffArgs, "-M", mergeBase, ...pathspec(ignore)]);
  for (const file of untrackedFiles(repoRoot, ignore))
    patch += git(repoRoot, [...diffArgs, "--no-index", "--", "/dev/null", file], [0, 1]);
  return patch;
}

function builtinLens(name: string): Lens {
  return { name, prompt: join(skillDir(), "prompts", "lenses", `${name}.md`), output: `findings/${name}.json` };
}

function resolveLenses(
  repoRoot: string,
  config: ReturnType<typeof loadConfig>["config"],
  hasSpecs: boolean,
  only: string[] | undefined,
): Lens[] {
  const preset = config.rigorPresets[config.rigor];
  const enabled = new Set<string>(config.lenses.enabled);
  const builtin: string[] = preset.lenses.filter((name) => enabled.has(name) && (name !== "spec" || hasSpecs));
  const lenses = builtin.map(builtinLens);
  for (const path of config.lenses.custom) {
    const name = basename(path).replace(/\.md$/, "");
    lenses.push({ name, prompt: resolve(repoRoot, path), output: `findings/${name}.json` });
  }
  if (!only) return lenses;
  const unknown = only.filter(
    (name) => !lenses.some((lens) => lens.name === name) && !(BUILTIN_LENSES as readonly string[]).includes(name),
  );
  if (unknown.length) throw new PrepareError(`unknown lens(es): ${unknown.join(", ")}`);
  return only.map((name) => lenses.find((lens) => lens.name === name) ?? builtinLens(name));
}

export function prepare(options: PrepareOptions): { runDir: string; context: Context } {
  const repoRoot = realpathSync(options.repoRoot);
  return withPrivateIndex(repoRoot, () => prepareIn(repoRoot, options));
}

function prepareIn(repoRoot: string, options: PrepareOptions): { runDir: string; context: Context } {
  const startedAt = options.now ?? new Date();
  const target = options.target ?? "current";
  if (target !== "current")
    throw new PrepareError(`target "${target}" is not supported yet; only "current" is implemented`);

  const sets = [...(options.sets ?? [])];
  if (options.rigor) sets.push(`rigor=${options.rigor}`);
  const { config } = loadConfig({ repoRoot, sets, userConfigPath: options.userConfigPath });

  const headSha = tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!headSha) throw new PrepareError("the repository has no commits yet");
  const base = options.base ?? config.base ?? detectBase(repoRoot);
  if (!base)
    throw new PrepareError("cannot detect the base branch (no origin/HEAD, main or master); pass --base <ref>");
  const baseRef = resolveBaseRef(repoRoot, base);
  const mergeBase = tryGit(repoRoot, ["merge-base", "HEAD", baseRef]);
  if (!mergeBase) throw new PrepareError(`HEAD and ${baseRef} share no history`);

  const patch = currentDiff(repoRoot, mergeBase, config.ignore);
  const diffFiles = parseDiff(patch);
  if (!diffFiles.length)
    throw new PrepareError(`nothing to review: no changes against ${baseRef} (merge-base ${mergeBase.slice(0, 12)})`);

  // Only touches .git/info/exclude and .review-flow/, never the working tree or index.
  ensureExcluded(repoRoot);
  const untracked = untrackedFiles(repoRoot, []);
  const dirty = untracked.length > 0 || git(repoRoot, ["diff", "--name-only", "HEAD", ...pathspec([])]).trim() !== "";
  // The index still lists files deleted in the working tree; only existing files can be specs or tests.
  const allFiles = [...git(repoRoot, ["ls-files", "-z"]).split("\0").filter(Boolean), ...untracked].filter((file) =>
    existsSync(join(repoRoot, file)),
  );

  const specs =
    config.specs ??
    detectSpecs(
      diffFiles.map((file) => file.path),
      allFiles,
    );
  const missingSpecs = specs.filter((spec) => !existsSync(join(repoRoot, spec)));
  if (missingSpecs.length) throw new PrepareError(`config specs not found: ${missingSpecs.join(", ")}`);
  const stack = detectStack(repoRoot);
  const detected = detectChecks(stack);
  const checks = {
    typecheck: config.checks.typecheck === undefined ? detected.typecheck : config.checks.typecheck,
    test: config.checks.test === undefined ? detected.test : config.checks.test,
  };
  const preset = config.rigorPresets[config.rigor];
  const harness = options.harness ?? "claude";
  if (harness !== "claude" && harness !== "cursor")
    throw new PrepareError(`unknown harness "${harness}" (claude|cursor)`);

  const runDir = createRunDir(repoRoot, "current", startedAt);
  const context: Context = {
    version: 1,
    run_id: basename(runDir),
    run_dir: runDir,
    created_at: startedAt.toISOString(),
    harness,
    skill_dir: skillDir(),
    repo_root: repoRoot,
    code_root: repoRoot,
    target: {
      mode: "current",
      branch: tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      base,
      base_ref: baseRef,
      merge_base: mergeBase,
      head_sha: headSha,
      dirty,
    },
    rigor: config.rigor,
    limits: { maxVerified: preset.maxVerified, parallel: preset.parallel, allowExecution: preset.allowExecution },
    models: config.models[harness],
    lenses: resolveLenses(repoRoot, config, specs.length > 0, options.lenses),
    specs,
    stack,
    checks,
    ignore: config.ignore,
    diff: "diff.patch",
    files: diffFiles.map((file) => fileContext(repoRoot, file, allFiles)),
  };
  writeFileSync(join(runDir, "diff.patch"), patch);
  writeFileSync(join(runDir, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
  appendTrace(runDir, {
    step: "prepare",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    harness,
  });
  return { runDir, context };
}

// --- CLI -------------------------------------------------------------------

const USAGE =
  "usage: prepare.mjs [--target current] [--base <ref>] [--rigor low|medium|high] [--lenses a,b]\n" +
  "                   [--harness claude|cursor] [--set key=value]... [--repo <dir>]";

const VALUE_FLAGS = ["--target", "--base", "--rigor", "--lenses", "--harness", "--set", "--repo"] as const;

export function main(argv: string[]): number {
  const values: Record<string, string> = {};
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf("=");
    const [flag, inline] =
      argv[i].startsWith("--") && eq > 0 ? [argv[i].slice(0, eq), argv[i].slice(eq + 1)] : [argv[i]];
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      console.error(`unexpected argument ${argv[i]}\n${USAGE}`);
      return 2;
    }
    const value = inline ?? argv[++i];
    if (!value) {
      console.error(`${flag} needs a value\n${USAGE}`);
      return 2;
    }
    if (flag === "--set") sets.push(value);
    else values[flag] = value;
  }
  const repoRoot = values["--repo"] ? resolve(values["--repo"]) : repoRootFrom(process.cwd());
  if (!repoRoot) {
    console.error("not inside a git repository; run from the repo or pass --repo <dir>");
    return 2;
  }
  try {
    const { runDir, context } = prepare({
      repoRoot,
      target: values["--target"],
      base: values["--base"],
      rigor: values["--rigor"],
      lenses: values["--lenses"]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      harness: values["--harness"],
      sets,
    });
    const t = context.target;
    console.log(
      `target: current (${t.branch ?? "detached"} @ ${t.head_sha.slice(0, 12)}${t.dirty ? ", dirty" : ""}) vs ${t.base_ref} (merge-base ${t.merge_base.slice(0, 12)})`,
    );
    console.log(
      `files: ${context.files.length} · rigor: ${context.rigor} · lenses: ${context.lenses.map((l) => l.name).join(", ")}`,
    );
    console.log(runDir);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error("invalid config:");
      for (const line of error.errors) console.error(`  ${line}`);
      return 1;
    }
    if (error instanceof PrepareError || error instanceof GitError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (isEntry(import.meta.url, "prepare")) {
  process.exitCode = main(process.argv.slice(2));
}
