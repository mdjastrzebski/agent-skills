/**
 * Stage 3: turns reviewer findings into verification candidates.
 * Findings in the same file and category whose line ranges overlap or lie within ±3 lines form one cluster
 * (transitively), which becomes one candidate. Candidates are ordered by severity, file and line, then cut to
 * `limits.maxVerified`.
 *
 * Usage: node scripts/dist/dedup.mjs <runDir>
 *
 * Writes `candidates.json` (Candidate[]), plus `candidates/<id>.json` holding that one candidate: verifiers read only
 * their own file, so no verifier's input contains another candidate. Also recreates an empty `verdicts/` for their
 * output, since candidate ids are positional and old verdicts may not match the new candidates.
 * Pairs that may still be duplicates (same file within ±10 lines but another category, or similar wording) go to
 * `possible-duplicates.json` for the optional merger pass.
 * Prints a summary, then `candidates: <id> <id> …` as the last line of stdout.
 * Exit 0 on success, 2 on usage errors or an unusable run directory.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { collectFindings, compareFindings } from "./findings.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import type { Candidate, Finding } from "./schemas.js";

/** Same file and category, at most this many lines apart: one cluster. */
export const CLUSTER_LINES = 3;
/** Same file, another category, at most this many lines apart: a possible duplicate. */
export const NEARBY_LINES = 10;
/** Jaccard similarity of title + claim words at or above which two candidates are possible duplicates. */
export const SIMILARITY_THRESHOLD = 0.5;

export type PossibleDuplicate = { a: string; b: string; reason: "nearby" | "similar"; similarity: number };

export type DedupResult = {
  candidates: Candidate[];
  findings: number;
  clusters: number;
  overLimit: Finding[];
  possibleDuplicates: PossibleDuplicate[];
};

type Range = { line_start: number; line_end: number };

/** Lines strictly between two ranges; 0 when they overlap or touch. */
function lineGap(a: Range, b: Range): number {
  return Math.max(0, Math.max(a.line_start, b.line_start) - Math.min(a.line_end, b.line_end));
}

/** Groups findings (already sorted) into clusters, each in input order. Clusters are linked transitively. */
export function clusterFindings(findings: Finding[]): Finding[][] {
  const parent = findings.map((_, index) => index);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < findings.length; i++)
    for (let j = i + 1; j < findings.length; j++) {
      const [a, b] = [findings[i], findings[j]];
      if (a.file === b.file && a.category === b.category && lineGap(a, b) <= CLUSTER_LINES) {
        const [ri, rj] = [root(i), root(j)];
        // The smaller index stays the root, so each cluster is keyed by its first (most severe) finding.
        parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  const clusters = new Map<number, Finding[]>();
  findings.forEach((finding, index) => {
    const key = root(index);
    clusters.set(key, [...(clusters.get(key) ?? []), finding]);
  });
  return [...clusters.values()];
}

/** A cluster's first finding speaks for it, over the union of the cluster's lines. */
function mergeCluster(cluster: Finding[]): Omit<Candidate, "id"> {
  const [primary] = cluster;
  return {
    ...primary,
    line_start: Math.min(...cluster.map((f) => f.line_start)),
    line_end: Math.max(...cluster.map((f) => f.line_end)),
    source_ids: cluster.map((f) => f.id),
  };
}

const STOPWORDS = new Set(
  "the and for with that this when from not are but can its has have was were will into than then also only does".split(
    " ",
  ),
);

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

export function similarity(a: string, b: string): number {
  const [wa, wb] = [words(a), words(b)];
  const shared = [...wa].filter((word) => wb.has(word)).length;
  const union = wa.size + wb.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function findPossibleDuplicates(candidates: Candidate[]): PossibleDuplicate[] {
  const pairs: PossibleDuplicate[] = [];
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const [a, b] = [candidates[i], candidates[j]];
      const score = Math.round(similarity(`${a.title} ${a.claim}`, `${b.title} ${b.claim}`) * 100) / 100;
      const nearby = a.file === b.file && a.category !== b.category && lineGap(a, b) <= NEARBY_LINES;
      if (nearby || score >= SIMILARITY_THRESHOLD)
        pairs.push({ a: a.id, b: b.id, reason: nearby ? "nearby" : "similar", similarity: score });
    }
  return pairs;
}

export function toCandidates(findings: Finding[], maxVerified: number): DedupResult {
  const clusters = clusterFindings(findings.toSorted(compareFindings))
    .map((cluster) => ({ cluster, merged: mergeCluster(cluster) }))
    .toSorted((a, b) => compareFindings({ ...a.merged, id: a.cluster[0].id }, { ...b.merged, id: b.cluster[0].id }));
  const candidates = clusters
    .slice(0, maxVerified)
    .map(({ merged }, index): Candidate => ({ ...merged, id: `c-${index + 1}` }));
  return {
    candidates,
    findings: findings.length,
    clusters: clusters.length,
    overLimit: clusters.slice(maxVerified).flatMap(({ cluster }) => cluster),
    possibleDuplicates: findPossibleDuplicates(candidates),
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

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
  writeFileSync(join(runDir, "candidates.json"), json(result.candidates));
  writeFileSync(join(runDir, "possible-duplicates.json"), json(result.possibleDuplicates));
  // Rewritten from scratch so a re-run never leaves a stale candidate behind.
  rmSync(join(runDir, "candidates"), { recursive: true, force: true });
  mkdirSync(join(runDir, "candidates"));
  for (const candidate of result.candidates)
    writeFileSync(join(runDir, "candidates", `${candidate.id}.json`), json(candidate));
  // Ids are positional, so a verdict from an earlier dedup could belong to a different finding: start clean.
  rmSync(join(runDir, "verdicts"), { recursive: true, force: true });
  mkdirSync(join(runDir, "verdicts"));
  appendTrace(runDir, {
    step: "dedup",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    findings: result.findings,
    clusters: result.clusters,
    candidates: result.candidates.length,
    possible_duplicates: result.possibleDuplicates.length,
  });
  return result;
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: dedup.mjs <runDir>");
    return 2;
  }
  try {
    const { candidates, findings, clusters, overLimit, possibleDuplicates } = dedup(argv[0]);
    console.log(
      `${candidates.length} candidate(s) to verify from ${findings} finding(s)${
        clusters < findings ? ` (${findings - clusters} merged as duplicates)` : ""
      }${overLimit.length ? `; ${overLimit.length} finding(s) over the verification limit, left unverified` : ""}`,
    );
    if (possibleDuplicates.length)
      console.log(`${possibleDuplicates.length} possible duplicate pair(s) in possible-duplicates.json`);
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
