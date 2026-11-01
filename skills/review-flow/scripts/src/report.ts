/**
 * Report: turns the ranked candidates into `report.md`: Fix before merge, Needs human judgment, Follow-up and
 * Dismissed, in `ranked.json` order (score, effort, path).
 *
 * Usage: node scripts/dist/report.mjs <runDir>
 *
 * Needs `candidates.json` (from dedup.mjs) and a matching `ranked.json` (from score.mjs). Candidates without a usable
 * verdict, and findings over the verification limit, are listed but never ranked.
 * Prints a short summary (counts and top items), then the report path as the last line of stdout.
 * Output depends only on the run directory's files, so re-runs are byte-identical.
 * Exit 0 on success (also when some findings or verdicts are invalid; the report lists them), 2 on usage errors
 * or an incomplete run directory.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { type Collected, collectFindings, readCandidates } from "./findings.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import type { Candidate, Finding } from "./schemas.js";
import { type Bucket, BUCKET_TITLES, BUCKETS, type Ranked, type RankedFile, readRanked } from "./scoring.js";

export type ReportInput = Collected & {
  candidates: Candidate[];
  ranked: RankedFile;
  /** Valid findings no candidate covers: over the verification limit. */
  unverified: Finding[];
};

export function unverifiedFindings(findings: Finding[], candidates: Candidate[]): Finding[] {
  const covered = new Set(candidates.flatMap((c) => c.source_ids));
  return findings.filter((f) => !covered.has(f.id));
}

const inBucket = (ranked: RankedFile, bucket: Bucket) => ranked.items.filter((item) => item.bucket === bucket);

const ACTIONS: Record<Bucket, string> = {
  fix: "Fix before merging.",
  judgment: "Decide whether this is real; the verifier could not settle it (see evidence).",
  "follow-up": "Fix in a follow-up, or now if it is cheap.",
  dismissed: "No action.",
};

/** A code fence longer than any backtick run inside `text`. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

function location(finding: Finding | Candidate): string {
  const lines =
    finding.line_start === finding.line_end ? `${finding.line_start}` : `${finding.line_start}-${finding.line_end}`;
  return `${finding.file}:${lines}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function severityLabel({ candidate, verdict }: Ranked): string {
  return verdict.severity_reassessed === candidate.severity
    ? verdict.severity_reassessed
    : `${verdict.severity_reassessed} (reviewer: ${candidate.severity})`;
}

const num = (value: number) => `${Math.round(value * 100) / 100}`;

function scoreLine({ verdict, score, breakdown }: Ranked): string {
  const confidence = verdict.verdict === "confirmed" ? `${verdict.verdict}, ${verdict.evidence_type}` : verdict.verdict;
  return `**Score ${num(score)}** = severity ${num(breakdown.severity)} (${verdict.severity_reassessed}) × confidence ${num(breakdown.confidence)} (${confidence}) × impact ${num(breakdown.impact)} (${verdict.impact})`;
}

function renderItem(item: Ranked): string[] {
  const { candidate, verdict } = item;
  const lines = [
    `### ${candidate.title}`,
    "",
    `\`${location(candidate)}\` · ${severityLabel(item)} · ${candidate.category} · ${verdict.impact} · effort: ${verdict.effort} · ${candidate.id} (${candidate.source_ids.join(", ")})`,
    "",
    candidate.claim.trim(),
    "",
    `**Verifier** (${verdict.verdict}, ${verdict.evidence_type})`,
    "",
    quote(verdict.evidence),
    "",
    scoreLine(item),
    "",
    `**Action:** ${ACTIONS[item.bucket]}`,
    "",
  ];
  const assessment = `${verdict.fix_assessment.status}${verdict.fix_assessment.notes.trim() ? `: ${verdict.fix_assessment.notes.trim()}` : ""}`;
  if (candidate.suggested_fix) {
    const fix = candidate.suggested_fix.trim();
    const isDiff = /^(diff --git|--- |@@ )/m.test(fix);
    const marks = fence(fix);
    lines.push(
      `<details><summary>Suggested fix (assessment: ${verdict.fix_assessment.status})</summary>`,
      "",
      `${marks}${isDiff ? "diff" : ""}`,
      fix,
      marks,
      "",
      `Assessment: ${assessment}`,
      "",
      "</details>",
      "",
    );
  } else if (verdict.fix_assessment.notes.trim()) {
    lines.push(`Fix: ${assessment}`, "");
  }
  return lines;
}

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDismissed(item: Ranked): string[] {
  const { candidate, verdict } = item;
  return [
    `<details><summary><b>${html(candidate.title)}</b> · <code>${html(location(candidate))}</code> · ${candidate.id} (${candidate.source_ids.join(", ")})</summary>`,
    "",
    candidate.claim.trim(),
    "",
    `**Verifier** (${verdict.verdict}, ${verdict.evidence_type})`,
    "",
    quote(verdict.evidence),
    "",
    scoreLine(item),
    "",
    "</details>",
    "",
  ];
}

function counts(ranked: RankedFile): string {
  return BUCKETS.map((bucket) => `${inBucket(ranked, bucket).length} ${BUCKET_TITLES[bucket].toLowerCase()}`).join(
    " · ",
  );
}

export function renderReport(context: Context, input: ReportInput): string {
  const { findings, outcomes, candidates, ranked, unverified } = input;
  const t = context.target;
  const lines = [
    `# Review: ${t.branch ?? "detached HEAD"} (current)`,
    "",
    `> Each candidate was checked by an independent, read-only verifier (traced or reasoned evidence; nothing was executed). Score = severity × confidence × impact; confirmed items scoring ${num(ranked.scoring.fixBeforeMergeThreshold)} or more are fix before merge.`,
    "",
    `- **Target:** current · branch \`${t.branch ?? "(detached)"}\` · HEAD \`${t.head_sha.slice(0, 12)}\`${t.dirty ? " · dirty (uncommitted changes included)" : ""}`,
    `- **Base:** \`${t.base_ref}\` (merge-base \`${t.merge_base.slice(0, 12)}\`)`,
    `- **Preset:** ${context.preset} · **Harness:** ${context.harness} · **Files changed:** ${context.files.length}`,
    `- **Lenses:** ${outcomes.map((o) => `${o.lens} (${o.status === "ok" ? o.count : o.status})`).join(", ")}`,
    `- **Verified:** ${candidates.length} candidate(s) from ${findings.length} finding(s) (limit ${context.limits.maxVerified})`,
    `- **Results:** ${counts(ranked)}${
      ranked.problems.length ? ` · ${ranked.problems.length} verification failed` : ""
    }${unverified.length ? ` · ${unverified.length} not verified (over limit)` : ""}`,
    "",
  ];
  const reviewerProblems = outcomes.filter((o) => o.status !== "ok");
  if (reviewerProblems.length) {
    lines.push("## Reviewer problems", "");
    for (const o of reviewerProblems) {
      lines.push(
        `- \`${o.file}\`: ${o.status === "missing" ? "not written (reviewer failed or did not finish)" : "invalid, skipped"}`,
      );
      for (const error of o.errors.slice(0, 5)) lines.push(`  - ${error}`);
      if (o.errors.length > 5) lines.push(`  - …and ${o.errors.length - 5} more`);
    }
    lines.push("");
  }
  if (ranked.problems.length) {
    lines.push("## Verification problems", "", "These candidates have no usable verdict and are not ranked.", "");
    for (const p of ranked.problems) {
      lines.push(
        `- \`verdicts/${p.candidate.id}.json\`: ${p.status === "missing" ? "not written" : "invalid"} · [${p.candidate.severity}] ${p.candidate.title} (\`${location(p.candidate)}\`)`,
      );
      for (const error of p.errors.slice(0, 5)) lines.push(`  - ${error}`);
      if (p.errors.length > 5) lines.push(`  - …and ${p.errors.length - 5} more`);
    }
    lines.push("");
  }
  if (!candidates.length) lines.push("No findings.", "");
  for (const bucket of BUCKETS) {
    const items = inBucket(ranked, bucket);
    if (!items.length) continue;
    lines.push(`## ${BUCKET_TITLES[bucket]} (${items.length})`, "");
    for (const item of items) lines.push(...(bucket === "dismissed" ? renderDismissed(item) : renderItem(item)));
  }
  if (unverified.length) {
    lines.push(
      `## Not verified (${unverified.length})`,
      "",
      "Over the verification limit; unchecked reviewer output.",
      "",
    );
    for (const f of unverified) lines.push(`- [${f.severity}] ${f.title} (\`${location(f)}\`) · ${f.id}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const SUMMARY_TAGS: Record<Bucket, string> = {
  fix: "fix",
  judgment: "needs judgment",
  "follow-up": "follow-up",
  dismissed: "dismissed",
};

/** The chat summary the agent relays: at most 10 lines. */
export function renderSummary(input: ReportInput, reportPath: string): string {
  const { outcomes, ranked, unverified } = input;
  const lines = [counts(ranked)];
  const problems = [
    ...outcomes.filter((o) => o.status !== "ok").map((o) => `reviewer ${o.lens} ${o.status}`),
    ...ranked.problems.map((p) => `verdict ${p.candidate.id} ${p.status}`),
  ];
  if (unverified.length) problems.push(`${unverified.length} finding(s) over the verification limit`);
  if (problems.length) lines.push(`problems: ${problems.join(", ")}`);
  const top = ranked.items.filter((item) => item.bucket !== "dismissed");
  for (const item of top.slice(0, 10 - lines.length - 1))
    lines.push(
      `- [${SUMMARY_TAGS[item.bucket]}, ${item.verdict.severity_reassessed}, ${num(item.score)}] ${item.candidate.title} (${location(item.candidate)})`,
    );
  lines.push(reportPath);
  return lines.join("\n");
}

export function report(runDirArg: string): { reportPath: string; summary: string } {
  const startedAt = new Date();
  const { runDir } = resolveRunDir(runDirArg);
  let context: Context;
  try {
    context = readContext(runDir);
  } catch (error) {
    throw new RunDirError(`cannot read ${join(runDir, "context.json")}: ${(error as Error).message}`);
  }
  const collected = collectFindings(runDir, context);
  const candidates = readCandidates(runDir);
  const ranked = readRanked(runDir, candidates);
  const input = { ...collected, candidates, ranked, unverified: unverifiedFindings(collected.findings, candidates) };
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, renderReport(context, input));
  appendTrace(runDir, {
    step: "report",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    findings: collected.findings.length,
    ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, inBucket(ranked, bucket).length])),
  });
  return { reportPath, summary: renderSummary(input, reportPath) };
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: report.mjs <runDir>");
    return 2;
  }
  try {
    console.log(report(argv[0]).summary);
    return 0;
  } catch (error) {
    if (!(error instanceof RunDirError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (isEntry(import.meta.url, "report")) {
  process.exitCode = main(process.argv.slice(2));
}
