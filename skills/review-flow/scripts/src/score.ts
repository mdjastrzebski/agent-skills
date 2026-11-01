/**
 * Stage 5: scores verified candidates and sorts them into buckets (§8), deterministically.
 *
 * Usage: node scripts/dist/score.mjs <runDir>
 *
 * Reads `candidates.json`, `verdicts/<id>.json` and the weights in `context.json`, writes `ranked.json`.
 * `score = severity × confidence × impact`; refuted → dismissed, uncertain → needs judgment (high or critical) or
 * dismissed, confirmed → fix before merge (score ≥ threshold) or follow-up. Within a bucket: score, effort, path.
 * Candidates without a usable verdict are listed in `problems`, never ranked.
 * Prints bucket counts. Output depends only on the run directory's files, so re-runs are byte-identical.
 * Exit 0 on success, 2 on usage errors or an incomplete run directory.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { readCandidates } from "./findings.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import { BUCKET_TITLES, BUCKETS, rankCandidates, type RankedFile } from "./scoring.js";

export function score(runDirArg: string): RankedFile {
  const startedAt = new Date();
  const { runDir } = resolveRunDir(runDirArg);
  let context: Context;
  try {
    context = readContext(runDir);
  } catch (error) {
    throw new RunDirError(`cannot read ${join(runDir, "context.json")}: ${(error as Error).message}`);
  }
  if (!context.scoring) throw new RunDirError(`${join(runDir, "context.json")} has no scoring weights: re-run prepare`);
  const ranked = rankCandidates(runDir, readCandidates(runDir), context.scoring);
  writeFileSync(join(runDir, "ranked.json"), `${JSON.stringify(ranked, null, 2)}\n`);
  appendTrace(runDir, {
    step: "score",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, ranked.items.filter((i) => i.bucket === bucket).length])),
    problems: ranked.problems.length,
  });
  return ranked;
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: score.mjs <runDir>");
    return 2;
  }
  try {
    const ranked = score(argv[0]);
    const counts = BUCKETS.map(
      (bucket) => `${ranked.items.filter((i) => i.bucket === bucket).length} ${BUCKET_TITLES[bucket].toLowerCase()}`,
    );
    if (ranked.problems.length) counts.push(`${ranked.problems.length} without a usable verdict`);
    console.log(counts.join(" · "));
    return 0;
  } catch (error) {
    if (!(error instanceof RunDirError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (isEntry(import.meta.url, "score")) {
  process.exitCode = main(process.argv.slice(2));
}
