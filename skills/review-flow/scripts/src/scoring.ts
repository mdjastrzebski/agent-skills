import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.js";
import { compareFindings, SEVERITY_RANK } from "./findings.js";
import { RunDirError } from "./run-dir.js";
import type { Candidate, Verdict } from "./schemas.js";
import { validateText } from "./validation.js";

/** §8 weights. The single source is `defaults.json` (`scoring`), layered by config and copied into `context.json`. */
export type Scoring = Context["scoring"];

export const BUCKETS = ["fix", "judgment", "follow-up", "dismissed"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_TITLES: Record<Bucket, string> = {
  fix: "Fix before merge",
  judgment: "Needs human judgment",
  "follow-up": "Follow-up",
  dismissed: "Dismissed",
};

const EFFORT_RANK = { trivial: 0, small: 1, medium: 2, large: 3 } as const;

export type Breakdown = { severity: number; confidence: number; impact: number };
export type Ranked = { candidate: Candidate; verdict: Verdict; bucket: Bucket; score: number; breakdown: Breakdown };
export type VerdictProblem = { candidate: Candidate; status: "missing" | "invalid"; errors: string[] };

/** `ranked.json`: self-contained, so the report and publishing need nothing else about verdicts. */
export type RankedFile = { version: 1; scoring: Scoring; items: Ranked[]; problems: VerdictProblem[] };

/** `score = severity_w × confidence × impact_w`, rounded to 3 decimals so bucketing never hinges on float noise. */
export function scoreVerdict(verdict: Verdict, scoring: Scoring): { score: number; breakdown: Breakdown } {
  const breakdown = {
    severity: scoring.severity[verdict.severity_reassessed],
    confidence:
      verdict.verdict === "confirmed"
        ? scoring.confidence.confirmed[verdict.evidence_type]
        : scoring.confidence[verdict.verdict],
    impact: scoring.impact[verdict.impact],
  };
  const score = Math.round(breakdown.severity * breakdown.confidence * breakdown.impact * 1000) / 1000;
  return { score, breakdown };
}

export function bucketOf(verdict: Verdict, score: number, scoring: Scoring): Bucket {
  if (verdict.verdict === "refuted") return "dismissed";
  if (verdict.verdict === "uncertain")
    return SEVERITY_RANK[verdict.severity_reassessed] <= SEVERITY_RANK.high ? "judgment" : "dismissed";
  return score >= scoring.fixBeforeMergeThreshold ? "fix" : "follow-up";
}

/** Bucket order, then score (highest first), then effort (cheapest first), then file path and line. */
export function compareRanked(a: Ranked, b: Ranked): number {
  return (
    BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) ||
    b.score - a.score ||
    EFFORT_RANK[a.verdict.effort] - EFFORT_RANK[b.verdict.effort] ||
    compareFindings({ ...a.candidate, severity: "low" }, { ...b.candidate, severity: "low" })
  );
}

/** Reads `verdicts/<id>.json` for each candidate; a verdict counts only if it validates and names its candidate. */
export function rankCandidates(runDir: string, candidates: Candidate[], scoring: Scoring): RankedFile {
  const items: Ranked[] = [];
  const problems: VerdictProblem[] = [];
  for (const candidate of candidates) {
    const path = join(runDir, "verdicts", `${candidate.id}.json`);
    if (!existsSync(path)) {
      problems.push({ candidate, status: "missing", errors: [] });
      continue;
    }
    const result = validateText("verdict", readFileSync(path, "utf8"));
    if (!result.ok) {
      problems.push({ candidate, status: "invalid", errors: result.errors });
      continue;
    }
    const verdict = result.data as Verdict;
    if (verdict.candidate_id !== candidate.id) {
      problems.push({
        candidate,
        status: "invalid",
        errors: [`candidate_id: expected "${candidate.id}", got "${verdict.candidate_id}"`],
      });
      continue;
    }
    const { score, breakdown } = scoreVerdict(verdict, scoring);
    items.push({ candidate, verdict, bucket: bucketOf(verdict, score, scoring), score, breakdown });
  }
  return { version: 1, scoring, items: items.toSorted(compareRanked), problems };
}

/** `ranked.json`, checked against `candidates.json` so a report never mixes two dedup runs. */
export function readRanked(runDir: string, candidates: Candidate[]): RankedFile {
  const path = join(runDir, "ranked.json");
  if (!existsSync(path)) throw new RunDirError(`${path} not found: run score.mjs first`);
  let ranked: RankedFile;
  try {
    ranked = JSON.parse(readFileSync(path, "utf8")) as RankedFile;
  } catch (error) {
    throw new RunDirError(`${path} is invalid: ${(error as Error).message}`);
  }
  if (ranked?.version !== 1 || !Array.isArray(ranked.items) || !Array.isArray(ranked.problems))
    throw new RunDirError(`${path} is invalid: re-run score.mjs`);
  const key = (list: Candidate[]) => JSON.stringify(list.toSorted((a, b) => a.id.localeCompare(b.id)));
  const scored = [...ranked.items, ...ranked.problems].map((entry) => entry.candidate);
  if (key(scored) !== key(candidates))
    throw new RunDirError(`${path} does not match candidates.json (dedup ran again?): re-run score.mjs`);
  return ranked;
}
