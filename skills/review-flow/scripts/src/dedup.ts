/**
 * Stage 3 (stub until step 5): turns reviewer findings into verification candidates.
 * No clustering yet: one candidate per valid finding, ordered by severity, file and line, cut to `limits.maxVerified`.
 *
 * Usage: node scripts/dist/dedup.mjs <runDir>
 *
 * Writes `candidates.json` (Candidate[]), plus `candidates/<id>.json` holding that one candidate: verifiers read only
 * their own file, so no verifier's input contains another candidate. Also recreates an empty `verdicts/` for their
 * output, since candidate ids are positional and old verdicts may not match the new candidates.
 * Prints a summary, then `candidates: <id> <id> …` as the last line of stdout.
 * Exit 0 on success, 2 on usage errors or an unusable run directory.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { collectFindings } from "./findings.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import type { Candidate, Finding } from "./schemas.js";

export type DedupResult = { candidates: Candidate[]; findings: number; overLimit: Finding[] };

export function toCandidates(findings: Finding[], maxVerified: number): DedupResult {
  const candidates = findings
    .slice(0, maxVerified)
    .map((finding, index): Candidate => ({ ...finding, id: `c-${index + 1}`, source_ids: [finding.id] }));
  return { candidates, findings: findings.length, overLimit: findings.slice(maxVerified) };
}

export function dedup(runDirArg: string): DedupResult {
  const startedAt = new Date();
  const { runDir } = resolveRunDir(runDirArg);
  let context: Context;
  try {
    context = readContext(runDir);
  } catch (error) {
    throw new RunDirError(`cannot read ${join(runDir, "context.json")}: ${(error as Error).message}`);
  }
  const result = toCandidates(collectFindings(runDir, context).findings, context.limits.maxVerified);
  writeFileSync(join(runDir, "candidates.json"), `${JSON.stringify(result.candidates, null, 2)}\n`);
  // Rewritten from scratch so a re-run never leaves a stale candidate behind.
  rmSync(join(runDir, "candidates"), { recursive: true, force: true });
  mkdirSync(join(runDir, "candidates"));
  for (const candidate of result.candidates)
    writeFileSync(join(runDir, "candidates", `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
  // Ids are positional, so a verdict from an earlier dedup could belong to a different finding: start clean.
  rmSync(join(runDir, "verdicts"), { recursive: true, force: true });
  mkdirSync(join(runDir, "verdicts"));
  appendTrace(runDir, {
    step: "dedup",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    findings: result.findings,
    candidates: result.candidates.length,
  });
  return result;
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: dedup.mjs <runDir>");
    return 2;
  }
  try {
    const { candidates, findings, overLimit } = dedup(argv[0]);
    console.log(
      `${candidates.length} candidate(s) to verify from ${findings} finding(s)${
        overLimit.length ? `; ${overLimit.length} over the verification limit, left unverified` : ""
      }`,
    );
    console.log(`candidates: ${candidates.map((c) => c.id).join(" ")}`.trimEnd());
    return 0;
  } catch (error) {
    if (!(error instanceof RunDirError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (isEntry(import.meta.url, "dedup")) {
  process.exitCode = main(process.argv.slice(2));
}
