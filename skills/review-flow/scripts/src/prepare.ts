/**
 * Stage 1: create a run directory with `context.json` and `diff.patch` for the reviewers.
 *
 * Usage: node scripts/dist/prepare.mjs [--target current] [--base <ref>] [--preset standard|deep]
 *                                      [--lenses a,b] [--harness claude|cursor] [--model role=model]...
 *                                      [--effort role=effort|default]... [--set key=value]... [--repo <dir>]
 *
 * Only `current` mode exists so far: the working tree (committed, staged, unstaged and untracked changes)
 * against its merge-base with `base`. `--base HEAD` reviews just the uncommitted changes.
 * Read-only towards the user's checkout: no checkout, stash, reset, or index refresh.
 *
 * `--model` / `--effort` override one role (reviewer, merger, verifier) in the chosen preset for the chosen harness,
 * as the matching `--set presets.<preset>.models.<harness>.<role>.…` would.
 *
 * Prints a short summary (target, files and lenses, preset and models, config files), then the run directory as the
 * last line of stdout.
 * Exit 0 on success, 1 on config/git errors or when there is nothing to review, 2 on usage errors.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isEntry } from "./cli.js";
import { BUILTIN_LENSES } from "./config-schema.js";
import { ConfigError, loadConfig, REPO_CONFIG_FILE, skillDir } from "./config.js";
import { type Context, detectSpecs, fileContext, type Lens, modelsLine, type Role, type RoleModel } from "./context.js";
import { detectBase, detectChecks, detectStack } from "./detect.js";
import { parseDiff } from "./diff.js";
import { git, GitError, repoRootFrom, tryGit, withPrivateIndex } from "./git.js";
import { appendTrace, createRunDir, ensureExcluded } from "./run-dir.js";

export class PrepareError extends Error {}

export type PrepareOptions = {
  repoRoot: string;
  target?: string;
  base?: string;
  preset?: string;
  lenses?: string[];
  harness?: string;
  /** `role=model` per-run overrides for the chosen preset and harness. */
  models?: string[];
  /** `role=effort` per-run overrides; `default` = the harness default (null). */
  efforts?: string[];
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
      // show-ref matches exact refs only; rev-parse would also accept `refs/remotes/origin/HEAD~1` for `HEAD~1`.
      if (tryGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]) !== null)
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

/** The §4 "second correctness pass" in the deep preset; not a config lens name, it follows `correctness`. */
export const SECOND_CORRECTNESS_LENS = "correctness-alt";

function builtinLens(name: string): Lens {
  return { name, prompt: join(skillDir(), "prompts", "lenses", `${name}.md`), output: `findings/${name}.json` };
}

function resolveLenses(
  repoRoot: string,
  config: ReturnType<typeof loadConfig>["config"],
  hasSpecs: boolean,
  only: string[] | undefined,
): Lens[] {
  const preset = config.presets[config.preset];
  const enabled = new Set<string>(config.lenses.enabled);
  const builtin: string[] = preset.lenses.filter((name) => enabled.has(name) && (name !== "spec" || hasSpecs));
  const lenses = builtin.map(builtinLens);
  for (const path of config.lenses.custom) {
    const name = basename(path).replace(/\.md$/, "");
    lenses.push({ name, prompt: resolve(repoRoot, path), output: `findings/${name}.json` });
  }
  const known = [...BUILTIN_LENSES, SECOND_CORRECTNESS_LENS] as readonly string[];
  const unknown = (only ?? []).filter((name) => !lenses.some((lens) => lens.name === name) && !known.includes(name));
  if (unknown.length) throw new PrepareError(`unknown lens(es): ${unknown.join(", ")}`);
  const chosen = only ? only.map((name) => lenses.find((lens) => lens.name === name) ?? builtinLens(name)) : lenses;
  // Deep preset: a second correctness reviewer with a different seed prompt runs wherever correctness runs.
  const index = chosen.findIndex((lens) => lens.name === "correctness");
  if (preset.secondCorrectnessPass && index >= 0 && !chosen.some((lens) => lens.name === SECOND_CORRECTNESS_LENS))
    chosen.splice(index + 1, 0, builtinLens(SECOND_CORRECTNESS_LENS));
  return chosen;
}

const ROLES: readonly Role[] = ["reviewer", "merger", "verifier"];

/** `--model` / `--effort` as `--set` overrides, so the config schema validates them like any other override. */
function roleSets(preset: string, harness: string, models: string[], efforts: string[]): string[] {
  const sets: string[] = [];
  for (const [field, args] of [
    ["model", models],
    ["effort", efforts],
  ] as const) {
    for (const arg of args) {
      const eq = arg.indexOf("=");
      const role = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (eq < 0 || !(ROLES as readonly string[]).includes(role) || !value)
        throw new PrepareError(`--${field} ${arg}: expected <${ROLES.join("|")}>=<${field}>`);
      const typed = field === "effort" && value === "default" ? "null" : value;
      sets.push(`presets.${preset}.models.${harness}.${role}.${field}=${typed}`);
    }
  }
  return sets;
}

/** Claude Code takes effort as its own subagent parameter; Cursor takes it as a model option. */
function resolveModels(models: Context["models"], harness: "claude" | "cursor"): Context["models"] {
  if (harness === "claude") return models;
  const resolved = { ...models };
  for (const [role, { model, effort }] of Object.entries(models) as [keyof typeof models, RoleModel][]) {
    if (effort && model.includes("["))
      throw new PrepareError(`${role}: set effort in the model id ("${model}") or in effort, not both`);
    resolved[role] = { model: effort ? `${model}[effort=${effort}]` : model, effort: null };
  }
  return resolved;
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

  const harness = options.harness ?? "claude";
  if (harness !== "claude" && harness !== "cursor")
    throw new PrepareError(`unknown harness "${harness}" (claude|cursor)`);
  const sets = [...(options.sets ?? [])];
  if (options.preset) sets.push(`preset=${options.preset}`);
  const load = (extra: string[]) =>
    loadConfig({ repoRoot, sets: [...sets, ...extra], userConfigPath: options.userConfigPath });
  let { config, files } = load([]);
  // Role overrides target whichever preset the layers chose, so they need a first pass to learn it.
  const roleOverrides = roleSets(config.preset, harness, options.models ?? [], options.efforts ?? []);
  if (roleOverrides.length) ({ config, files } = load(roleOverrides));

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
  const preset = config.presets[config.preset];

  const runDir = createRunDir(repoRoot, "current", startedAt);
  const context: Context = {
    version: 1,
    run_id: basename(runDir),
    run_dir: runDir,
    created_at: startedAt.toISOString(),
    harness,
    config_files: files.flatMap((file) =>
      file.found && file.source !== "default" ? [{ source: file.source, path: file.path }] : [],
    ),
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
    preset: config.preset,
    limits: { maxVerified: preset.maxVerified, parallel: preset.parallel, allowExecution: preset.allowExecution },
    models: resolveModels(preset.models[harness], harness),
    scoring: config.scoring,
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
    preset: context.preset,
    models: context.models,
  });
  return { runDir, context };
}

// --- CLI -------------------------------------------------------------------

const USAGE =
  "usage: prepare.mjs [--target current] [--base <ref>] [--preset standard|deep] [--lenses a,b]\n" +
  "                   [--harness claude|cursor] [--model role=model]... [--effort role=effort|default]...\n" +
  "                   [--set key=value]... [--repo <dir>]";

const VALUE_FLAGS = [
  "--target",
  "--base",
  "--preset",
  "--lenses",
  "--harness",
  "--model",
  "--effort",
  "--set",
  "--repo",
] as const;
const REPEATED_FLAGS = ["--model", "--effort", "--set"];

export function main(argv: string[]): number {
  const values: Record<string, string> = {};
  const repeated: Record<string, string[]> = Object.fromEntries(REPEATED_FLAGS.map((flag) => [flag, []]));
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
    if (REPEATED_FLAGS.includes(flag)) repeated[flag].push(value);
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
      preset: values["--preset"],
      lenses: values["--lenses"]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      harness: values["--harness"],
      models: repeated["--model"],
      efforts: repeated["--effort"],
      sets: repeated["--set"],
    });
    const t = context.target;
    console.log(
      `target: current (${t.branch ?? "detached"} @ ${t.head_sha.slice(0, 12)}${t.dirty ? ", dirty" : ""}) vs ${t.base_ref} (merge-base ${t.merge_base.slice(0, 12)})`,
    );
    console.log(`files: ${context.files.length} · lenses: ${context.lenses.map((l) => l.name).join(", ")}`);
    console.log(`preset: ${context.preset} · ${modelsLine(context.models)} · lenses: ${context.lenses.length}`);
    console.log(
      context.config_files.length
        ? `config: ${context.config_files.map((file) => `${file.source} ${file.path}`).join(", ")}`
        : `config: built-in defaults only (no ${REPO_CONFIG_FILE}; config.mjs init creates one)`,
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
