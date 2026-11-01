import { lstatSync, readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import type { Config } from "./config-schema.js";
import type { Checks, Stack } from "./detect.js";
import type { DiffFile } from "./diff.js";

/** Reviewers read at most this many lines of a changed file in full; beyond it, the hunks and their surroundings. */
export const FULL_FILE_LINE_CAP = 800;
const MAX_TESTS = 5;

export type FileContext = DiffFile & {
  lines: number | null;
  truncated: boolean;
  imports: string[];
  tests: string[];
};

export type Lens = { name: string; prompt: string; output: string };

const MAX_SPECS = 10;
// Case-sensitive on purpose: a lowercase `spec.md` is often something else (e.g. this skill's own lens prompt).
const SPEC_FILE = /(^|\/)((SPEC|PRD|REQUIREMENTS)\.md|[^/]+\.spec\.md|specs\/.+\.md)$/;

/**
 * Spec documents for the spec lens: markdown named like a spec (SPEC.md, PRD.md, REQUIREMENTS.md, *.spec.md,
 * specs/**.md) in a directory that contains a changed file, nearest first.
 */
export function detectSpecs(changed: string[], allFiles: string[]): string[] {
  const dirs = new Set(
    changed.flatMap((file) => {
      const parts = file.split("/").slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join("/")).concat("");
    }),
  );
  const owner = (spec: string) => posix.dirname(spec.replace(/(^|\/)specs\/.*$/, "$1x")).replace(/^\.$/, "");
  return allFiles
    .filter((file) => SPEC_FILE.test(file) && dirs.has(owner(file)))
    .toSorted((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))
    .slice(0, MAX_SPECS);
}

/** `context.json`: everything later stages need, so no step re-derives it. Paths are absolute unless noted. */
export type Context = {
  version: 1;
  run_id: string;
  run_dir: string;
  created_at: string;
  harness: string;
  skill_dir: string;
  repo_root: string;
  code_root: string;
  target: {
    mode: "current";
    branch: string | null;
    base: string;
    base_ref: string;
    merge_base: string;
    head_sha: string;
    dirty: boolean;
  };
  rigor: string;
  limits: { maxVerified: number; parallel: number; allowExecution: boolean };
  models: { reviewer: string; merger: string; verifier: string };
  /** §8 weights from the effective config, copied so re-scoring a run never depends on today's config. */
  scoring: Config["scoring"];
  lenses: Lens[];
  /** Spec documents the spec lens checks against, relative to `code_root`. */
  specs: string[];
  stack: Stack | null;
  checks: Checks;
  ignore: string[];
  /** Relative to the run directory. */
  diff: string;
  /** Paths relative to `code_root`. */
  files: FileContext[];
};

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT_PATTERN =
  /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

/** Regular files only: a changed symlink could point outside the repo, so it is never read. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Relative imports of a JS/TS file, resolved to existing repo paths (NodeNext `.js` specifiers map to `.ts`). */
export function resolveImports(codeRoot: string, file: string, source: string): string[] {
  if (!CODE_EXTENSIONS.includes(extname(file))) return [];
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier?.startsWith(".")) continue;
    const base = posix.normalize(posix.join(posix.dirname(file), specifier));
    const stem = base.replace(/\.(m|c)?jsx?$/, "");
    const candidates = [
      base,
      ...CODE_EXTENSIONS.map((ext) => stem + ext),
      ...CODE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ];
    const hit = candidates.find((candidate) => !candidate.startsWith("..") && isFile(join(codeRoot, candidate)));
    if (hit && hit !== file) found.add(hit);
  }
  return [...found].toSorted();
}

const TEST_FILE = /(^|\/)(__tests__\/[^/]+|[^/]+\.(test|spec)\.[^/]+)$/;

function stemOf(path: string): string {
  return posix
    .basename(path)
    .replace(/\.(test|spec)(?=\.[^.]+$)/, "")
    .replace(/\.[^.]+$/, "");
}

/** Test files that look like they cover `file`: same stem, named `*.test.*` / `*.spec.*` or under `__tests__/`. */
export function matchTests(file: string, allFiles: string[]): string[] {
  if (TEST_FILE.test(file)) return [];
  const stem = stemOf(file);
  // Tests next to (or below) the file first, then the rest by path.
  const near = (candidate: string) => (candidate.startsWith(`${posix.dirname(file)}/`) ? 0 : 1);
  return allFiles
    .filter((candidate) => candidate !== file && TEST_FILE.test(candidate) && stemOf(candidate) === stem)
    .toSorted((a, b) => near(a) - near(b) || a.localeCompare(b))
    .slice(0, MAX_TESTS);
}

export function fileContext(codeRoot: string, diff: DiffFile, allFiles: string[]): FileContext {
  const absolute = join(codeRoot, diff.path);
  let source: string | null = null;
  if (diff.status !== "deleted" && !diff.binary && isFile(absolute)) source = readFileSync(absolute, "utf8");
  const lines = source === null ? null : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return {
    ...diff,
    lines,
    truncated: lines !== null && lines > FULL_FILE_LINE_CAP,
    imports: source === null ? [] : resolveImports(codeRoot, diff.path, source),
    tests: diff.status === "deleted" ? [] : matchTests(diff.path, allFiles),
  };
}

export function readContext(runDir: string): Context {
  return JSON.parse(readFileSync(join(runDir, "context.json"), "utf8")) as Context;
}
