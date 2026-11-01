import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, repoRootFrom } from "./git.js";

/** Every run lives under `<repo>/.review-flow/runs/`. */
export const RUNS_DIR = join(".review-flow", "runs");

export class RunDirError extends Error {}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** `<UTC date>-<UTC time>`, e.g. 20261101-142305. */
export function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function createRunDir(repoRoot: string, slug: string, now: Date): string {
  const runs = join(repoRoot, RUNS_DIR);
  mkdirSync(runs, { recursive: true });
  const base = `${slug}-${timestamp(now)}`;
  for (let n = 1; ; n++) {
    const runDir = join(runs, n === 1 ? base : `${base}-${n}`);
    if (existsSync(runDir)) continue;
    mkdirSync(join(runDir, "findings"), { recursive: true });
    return runDir;
  }
}

/**
 * Resolves a run-directory argument and refuses anything outside `<repo>/.review-flow/runs/`.
 * Returns the real path of the run directory and of the repo that owns it.
 */
export function resolveRunDir(arg: string): { runDir: string; repoRoot: string } {
  const abs = resolve(arg);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new RunDirError(`run directory not found: ${arg}`);
  const runDir = realpathSync(abs);
  const repoRoot = repoRootFrom(runDir);
  if (!repoRoot || !isInside(runDir, join(realpathSync(repoRoot), RUNS_DIR)))
    throw new RunDirError(`refusing ${arg}: run directories must be inside <repo>/${RUNS_DIR.split(sep).join("/")}/`);
  return { runDir, repoRoot: realpathSync(repoRoot) };
}

/** Adds `.review-flow/` to `.git/info/exclude` (once), so runs never show up as untracked changes. */
export function ensureExcluded(repoRoot: string): void {
  const excludeFile = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-path", "info/exclude"]).trim());
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === ".review-flow/" || line.trim() === "/.review-flow/"))
    return;
  mkdirSync(dirname(excludeFile), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(excludeFile, `${current}${separator}.review-flow/\n`);
}

export type TraceEntry = { step: string; status: "ok" | "error"; started_at: string; duration_ms: number } & Record<
  string,
  unknown
>;

export function appendTrace(runDir: string, entry: TraceEntry): void {
  appendFileSync(join(runDir, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
}
