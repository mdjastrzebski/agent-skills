import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.js";
import { RunDirError } from "./run-dir.js";
import { type Candidate, type Finding, SEVERITIES } from "./schemas.js";
import { validateText } from "./validation.js";

export type LensOutcome = {
  lens: string;
  file: string;
  status: "ok" | "missing" | "invalid";
  count: number;
  errors: string[];
};

export type Collected = { findings: Finding[]; outcomes: LensOutcome[] };

export const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index]));

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line_start - b.line_start ||
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
}

/** Reads every expected lens output plus any extra `findings/*.json`, validating each file. */
export function collectFindings(runDir: string, context: Context): Collected {
  const expected = context.lenses.map((lens) => ({ lens: lens.name, file: lens.output }));
  const dir = join(runDir, "findings");
  const extra = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => `findings/${name}`)
        .filter((file) => !expected.some((entry) => entry.file === file))
        .toSorted()
        .map((file) => ({ lens: file.slice("findings/".length, -".json".length), file }))
    : [];
  const findings: Finding[] = [];
  const outcomes = [...expected, ...extra].map(({ lens, file }): LensOutcome => {
    const path = join(runDir, file);
    if (!existsSync(path)) return { lens, file, status: "missing", count: 0, errors: [] };
    const result = validateText("findings", readFileSync(path, "utf8"));
    if (!result.ok) return { lens, file, status: "invalid", count: 0, errors: result.errors };
    const items = result.data as Finding[];
    findings.push(...items);
    return { lens, file, status: "ok", count: items.length, errors: [] };
  });
  return { findings: findings.toSorted(compareFindings), outcomes };
}

/** `candidates.json`, validated; a missing or invalid file means dedup hasn't run (properly). */
export function readCandidates(runDir: string): Candidate[] {
  const path = join(runDir, "candidates.json");
  if (!existsSync(path)) throw new RunDirError(`${path} not found: run dedup.mjs first`);
  const result = validateText("candidates", readFileSync(path, "utf8"));
  if (!result.ok) throw new RunDirError(`${path} is invalid: ${result.errors.slice(0, 3).join("; ")}`);
  return result.data as Candidate[];
}
