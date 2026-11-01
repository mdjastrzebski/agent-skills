/**
 * Effective review-flow config: defaults.json < user file < repo file < --set overrides (later wins).
 *
 * Usage:
 *   node scripts/dist/config.mjs show [--json] [--set key=value]... [--repo <dir>]
 *   node scripts/dist/config.mjs init [--force] [--repo <dir>]
 *
 * `show` prints each effective value with its source (default / user / repo / override).
 * `init` writes `review-flow.config.json` at the repo root: detected values active, defaults commented out.
 * Files are JSON with comments and trailing commas allowed. Unknown keys are errors with a "did you mean" hint.
 *
 * Exit 0 on success, 1 on config errors (one line per issue on stderr), 2 on usage errors.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { z } from "zod";
import { isEntry } from "./cli.js";
import { Config, ConfigFile, type ConfigLayer, keysAt, schemaAt, unwrap } from "./config-schema.js";
import { detectBase, detectChecks, detectStack } from "./detect.js";
import { formatIssue, formatPath } from "./issues.js";

export type Source = "default" | "user" | "repo" | "override";
export type LayerFile = { source: Exclude<Source, "override">; path: string; found: boolean };
export type LoadedConfig = { config: Config; sources: Record<string, Source>; files: LayerFile[] };

export const REPO_CONFIG_FILE = "review-flow.config.json";

export class ConfigError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("\n"));
  }
}

/** The skill folder; `src/` and `dist/` both sit two levels below it. */
export function skillDir(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "review-flow", "config.json");
}

// --- JSONC -----------------------------------------------------------------

/** JSON.parse that also accepts // and /* *\/ comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Blank out comments instead of deleting them, so JSON.parse positions still match the file.
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === ",") {
      out += isTrailingComma(text, i + 1) ? " " : ",";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

function isTrailingComma(text: string, from: number): boolean {
  let j = from;
  for (;;) {
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text.startsWith("//", j)) {
      while (j < text.length && text[j] !== "\n") j++;
    } else if (text.startsWith("/*", j)) {
      const end = text.indexOf("*/", j + 2);
      j = end === -1 ? text.length : end + 2;
    } else {
      return text[j] === "}" || text[j] === "]";
    }
  }
}

// --- validation ------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export function closestKey(key: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const option of options) {
    const distance = editDistance(key.toLowerCase(), option.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [option, distance];
  }
  return bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

function issueLines(schema: z.ZodType, input: unknown, label: string): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [`${label}: ${formatIssue(issue, input)}`];
    const valid = keysAt(schema, issue.path);
    return issue.keys.map((key) => {
      const suggestion = closestKey(key, valid);
      const hint = suggestion ? `did you mean "${suggestion}"?` : `valid keys: ${valid.join(", ")}`;
      return `${label}: ${formatPath([...issue.path, key])}: unknown key (${hint})`;
    });
  });
}

// --- --set overrides -------------------------------------------------------

/** Turns `key.path=value` into a nested layer, typing the raw value by the schema node it targets. */
export function parseSet(arg: string): ConfigLayer {
  const eq = arg.indexOf("=");
  if (eq <= 0)
    throw new ConfigError([
      `--set ${arg}: expected key=value, e.g. --set presets.deep.models.claude.verifier.effort=max`,
    ]);
  const path = arg.slice(0, eq).split(".");
  const raw = arg.slice(eq + 1);
  if (path.some((part) => part === ""))
    throw new ConfigError([`--set ${arg}: empty segment in key "${arg.slice(0, eq)}"`]);

  let value: unknown = raw;
  const node = schemaAt(ConfigFile, path);
  const type = node ? (unwrap(node) as any)._zod.def.type : undefined;
  if (raw === "null" && node?.safeParse(null).success) value = null;
  else if (type === "string" || type === "enum") value = raw;
  else if (type === "array" && !raw.trimStart().startsWith("["))
    value = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  else {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as ConfigLayer;
}

// --- loading ---------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars replace. */
function merge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over))
    out[key] = key in out ? merge(out[key], value) : structuredClone(value);
  return out;
}

function leafPaths(value: unknown, prefix: string[] = []): string[] {
  if (!isPlainObject(value)) return prefix.length ? [prefix.join(".")] : [];
  return Object.entries(value).flatMap(([key, inner]) => leafPaths(inner, [...prefix, key]));
}

function readLayer(path: string): { found: boolean; data?: unknown; error?: string } {
  if (!existsSync(path)) return { found: false };
  try {
    return { found: true, data: parseJsonc(readFileSync(path, "utf8")) };
  } catch (error) {
    return { found: true, error: `${path}: cannot parse: ${(error as Error).message}` };
  }
}

export function loadDefaults(path = join(skillDir(), "defaults.json")): Config {
  return Config.parse(parseJsonc(readFileSync(path, "utf8")));
}

export type LoadOptions = {
  repoRoot?: string;
  userConfigPath?: string;
  defaultsPath?: string;
  sets?: string[];
};

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const files: LayerFile[] = [
    { source: "default", path: options.defaultsPath ?? join(skillDir(), "defaults.json"), found: false },
    { source: "user", path: options.userConfigPath ?? userConfigPath(), found: false },
  ];
  if (options.repoRoot) files.push({ source: "repo", path: join(options.repoRoot, REPO_CONFIG_FILE), found: false });

  const errors: string[] = [];
  const layers: { source: Source; data: unknown }[] = [];
  for (const file of files) {
    const read = readLayer(file.path);
    file.found = read.found;
    if (read.error) errors.push(read.error);
    else if (read.found) {
      const issues = issueLines(file.source === "default" ? Config : ConfigFile, read.data, file.path);
      errors.push(...issues);
      const { $schema, ...data } = read.data as Record<string, unknown>;
      if (!issues.length) layers.push({ source: file.source, data });
    }
  }
  if (!files[0].found) errors.unshift(`${files[0].path}: built-in defaults are missing`);

  for (const arg of options.sets ?? []) {
    try {
      const data = parseSet(arg);
      const issues = issueLines(ConfigFile, data, `--set ${arg}`);
      errors.push(...issues);
      if (!issues.length) layers.push({ source: "override", data });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      errors.push(...error.errors);
    }
  }
  if (errors.length) throw new ConfigError(errors);

  let merged: unknown = {};
  const sources: Record<string, Source> = {};
  for (const layer of layers) {
    merged = merge(merged, layer.data);
    for (const path of leafPaths(layer.data)) sources[path] = layer.source;
  }
  const result = Config.safeParse(merged);
  if (!result.success) throw new ConfigError(issueLines(Config, merged, "effective config"));
  return { config: result.data, sources, files };
}

// --- show ------------------------------------------------------------------

/** Every leaf the schema defines, including optional ones that are unset. */
function schemaLeaves(schema: z.ZodType, prefix: string[] = []): string[][] {
  const inner = unwrap(schema) as any;
  if (inner._zod.def.type !== "object") return [prefix];
  return Object.entries(inner._zod.def.shape).flatMap(([key, value]) =>
    schemaLeaves(value as z.ZodType, [...prefix, key]),
  );
}

export function renderShow(loaded: LoadedConfig): string {
  const lines = ["files:"];
  for (const file of loaded.files)
    lines.push(`  ${file.source.padEnd(8)} ${file.path}${file.found ? "" : " (not found)"}`);
  lines.push("values:");
  const rows = schemaLeaves(Config).map((path) => {
    const key = path.join(".");
    const value = path.reduce<any>((current, part) => current?.[part], loaded.config);
    return {
      key,
      value: value === undefined ? "(auto-detect)" : JSON.stringify(value),
      source: loaded.sources[key] ?? "default",
    };
  });
  const width = Math.max(...rows.map((row) => row.key.length));
  for (const row of rows) lines.push(`  ${row.key.padEnd(width)} = ${row.value}  [${row.source}]`);
  return lines.join("\n");
}

// --- init ------------------------------------------------------------------

// Shown (commented) for keys whose default is empty or absent, so the file documents their shape.
const EXAMPLES: Partial<Record<keyof Config, unknown>> = {
  base: "main",
  specs: ["SPEC.md", "docs/specs/feature.md"],
  checks: { typecheck: "npm run typecheck", test: "npm run test" },
  ignore: ["**/*.snap", "**/generated/**"],
  lenses: {
    enabled: ["correctness", "security", "tests", "performance", "spec"],
    custom: ["./.review-flow-lenses/accessibility.md"],
  },
};

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && !value.length) ||
    (isPlainObject(value) && !Object.keys(value).length)
  );
}

/** `$schema` reference: repo-relative when the skill lives inside the repo, else a file URL to the installed copy. */
export function schemaRef(skill: string, repoRoot: string): string {
  const schema = join(skill, "schemas", "config.schema.json");
  const rel = relative(repoRoot, schema);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `./${rel.split(sep).join("/")}`;
  return pathToFileURL(schema).href;
}

export function detectLayer(repoRoot: string): ConfigLayer {
  const layer: ConfigLayer = {};
  const base = detectBase(repoRoot);
  if (base) layer.base = base;
  const stack = detectStack(repoRoot);
  const checks = Object.fromEntries(Object.entries(detectChecks(stack)).filter(([, command]) => command !== null));
  if (Object.keys(checks).length) layer.checks = checks;
  if (stack?.reactNative) layer.ignore = ["ios/Pods/**", "**/*.snap"];
  return layer;
}

function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  const entries = Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${inlineJson(inner)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

/** Pretty JSON that keeps any value fitting in ~100 columns on one line. */
function compactJson(value: unknown, indent = ""): string {
  const inline = inlineJson(value);
  if (indent.length + inline.length <= 100 || !(Array.isArray(value) || isPlainObject(value))) return inline;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((item) => next + compactJson(item, next)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value).map(
    ([key, inner]) => `${next}${JSON.stringify(key)}: ${compactJson(inner, next)}`,
  );
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

export function renderInit(defaults: Config, detected: ConfigLayer, ref: string): string {
  const block = (key: string, value: unknown, comma: boolean, comment: boolean) => {
    const lines = `${JSON.stringify(key)}: ${compactJson(value)}${comma ? "," : ""}`.split("\n");
    return lines.map((line) => `  ${comment ? "// " : ""}${line}`);
  };
  const keys = Object.keys((Config as any)._zod.def.shape) as (keyof Config)[];
  const active = keys.filter(
    (key) => detected[key] !== undefined && JSON.stringify(detected[key]) !== JSON.stringify(defaults[key]),
  );
  const lines = [
    "{",
    "  // review-flow config, shared by the team. Commented keys show built-in defaults (or examples); uncomment to override.",
    "  // `node <skill>/scripts/dist/config.mjs show` prints the effective config and where each value comes from.",
  ];
  for (const key of keys.filter((k) => !active.includes(k))) {
    const value = isEmpty(defaults[key]) ? (EXAMPLES[key] ?? defaults[key]) : defaults[key];
    lines.push(...block(key, value, true, true));
  }
  // Active keys last and `$schema` at the very end, so uncommenting any line above keeps the JSON valid.
  for (const key of active) lines.push(...block(key, detected[key], true, false));
  lines.push(`  "$schema": ${JSON.stringify(ref)}`, "}", "");
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------

type Args = { command?: string; repo?: string; sets: string[]; json: boolean; force: boolean; error?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { sets: [], json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--set" || arg === "--repo") {
      const value = argv[++i];
      if (value === undefined) return { ...args, error: `${arg} needs a value` };
      if (arg === "--set") args.sets.push(value);
      else args.repo = value;
    } else if (arg.startsWith("--set=")) args.sets.push(arg.slice(6));
    else if (!args.command && !arg.startsWith("-")) args.command = arg;
    else return { ...args, error: `unexpected argument ${arg}` };
  }
  return args;
}

function repoRootFrom(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const USAGE =
  "usage: config.mjs show [--json] [--set key=value]... [--repo <dir>]\n       config.mjs init [--force] [--repo <dir>]";

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error || (args.command !== "show" && args.command !== "init")) {
    console.error(args.error ? `${args.error}\n${USAGE}` : USAGE);
    return 2;
  }
  const repoRoot = args.repo ? resolve(args.repo) : repoRootFrom(process.cwd());
  if (!repoRoot) {
    console.error("not inside a git repository; run from the repo or pass --repo <dir>");
    return 2;
  }
  try {
    if (args.command === "show") {
      const loaded = loadConfig({ repoRoot, sets: args.sets });
      console.log(args.json ? JSON.stringify(loaded, null, 2) : renderShow(loaded));
      return 0;
    }
    const target = join(repoRoot, REPO_CONFIG_FILE);
    if (existsSync(target) && !args.force) {
      console.error(`${target} already exists; pass --force to overwrite`);
      return 1;
    }
    const text = renderInit(loadDefaults(), detectLayer(repoRoot), schemaRef(skillDir(), repoRoot));
    const issues = issueLines(ConfigFile, parseJsonc(text), "generated config");
    if (issues.length) throw new ConfigError(issues);
    writeFileSync(target, text);
    console.log(text);
    console.log(`wrote ${target}`);
    return 0;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error("invalid config:");
    for (const line of error.errors) console.error(`  ${line}`);
    return 1;
  }
}

if (isEntry(import.meta.url, "config")) {
  process.exitCode = main(process.argv.slice(2));
}
