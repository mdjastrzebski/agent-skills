/**
 * Report: turns verified candidates into `report.md`, bucketed by verdict.
 * Ranking is a placeholder until scoring (step 5): Confirmed, then Needs judgment (uncertain), then Dismissed
 * (refuted); within a bucket by reassessed severity, evidence strength, file and line.
 *
 * Usage: node scripts/dist/report.mjs <runDir>
 *
 * Needs `candidates.json` (from dedup.mjs) and reads `verdicts/<id>.json` for each candidate. Candidates whose
 * verdict is missing or invalid, and findings over the verification limit, are listed but never ranked.
 * Prints a short summary (counts and top items), then the report path as the last line of stdout.
 * Output depends only on the run directory's files, so re-runs are byte-identical.
 * Exit 0 on success (also when some findings or verdicts are invalid; the report lists them), 2 on usage errors
 * or an incomplete run directory.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { type Collected, collectFindings, compareFindings, SEVERITY_RANK } from "./findings.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import type { Candidate, Finding, Verdict } from "./schemas.js";
import { validateText } from "./validation.js";

export type Verified = { candidate: Candidate; verdict: Verdict };
export type VerdictProblem = { candidate: Candidate; status: "missing" | "invalid"; errors: string[] };

export type Buckets = {
  confirmed: Verified[];
  judgment: Verified[];
  dismissed: Verified[];
  problems: VerdictProblem[];
  /** Valid findings no candidate covers: over the verification limit. */
  unverified: Finding[];
};

export type ReportInput = Collected & { candidates: Candidate[]; buckets: Buckets };

const EVIDENCE_RANK = { executed: 0, traced: 1, reasoned: 2 } as const;

function compareVerified(a: Verified, b: Verified): number {
  return (
    SEVERITY_RANK[a.verdict.severity_reassessed] - SEVERITY_RANK[b.verdict.severity_reassessed] ||
    EVIDENCE_RANK[a.verdict.evidence_type] - EVIDENCE_RANK[b.verdict.evidence_type] ||
    compareFindings(a.candidate, b.candidate)
  );
}

export function readCandidates(runDir: string): Candidate[] {
  const path = join(runDir, "candidates.json");
  if (!existsSync(path)) throw new RunDirError(`${path} not found: run dedup.mjs first`);
  const result = validateText("candidates", readFileSync(path, "utf8"));
  if (!result.ok) throw new RunDirError(`${path} is invalid: ${result.errors.slice(0, 3).join("; ")}`);
  return result.data as Candidate[];
}

/** Reads `verdicts/<id>.json` for each candidate and sorts the results into placeholder buckets. */
export function bucketVerdicts(runDir: string, candidates: Candidate[], findings: Finding[]): Buckets {
  const verified: Verified[] = [];
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
    verified.push({ candidate, verdict });
  }
  const sorted = verified.toSorted(compareVerified);
  const covered = new Set(candidates.flatMap((c) => c.source_ids));
  return {
    confirmed: sorted.filter((v) => v.verdict.verdict === "confirmed"),
    judgment: sorted.filter((v) => v.verdict.verdict === "uncertain"),
    dismissed: sorted.filter((v) => v.verdict.verdict === "refuted"),
    problems,
    unverified: findings.filter((f) => !covered.has(f.id)),
  };
}

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

function severityLabel({ candidate, verdict }: Verified): string {
  return verdict.severity_reassessed === candidate.severity
    ? verdict.severity_reassessed
    : `${verdict.severity_reassessed} (reviewer: ${candidate.severity})`;
}

function renderItem(item: Verified): string[] {
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

function renderDismissed({ candidate, verdict }: Verified): string[] {
  return [
    `<details><summary><b>${html(candidate.title)}</b> · <code>${html(location(candidate))}</code> · ${candidate.id} (${candidate.source_ids.join(", ")})</summary>`,
    "",
    candidate.claim.trim(),
    "",
    `**Verifier** (refuted, ${verdict.evidence_type})`,
    "",
    quote(verdict.evidence),
    "",
    "</details>",
    "",
  ];
}

export function renderReport(context: Context, input: ReportInput): string {
  const { findings, outcomes, candidates, buckets } = input;
  const t = context.target;
  const lines = [
    `# Review: ${t.branch ?? "detached HEAD"} (current)`,
    "",
    "> Each candidate was checked by an independent, read-only verifier (traced or reasoned evidence; nothing was executed). Ranking is provisional until scoring lands.",
    "",
    `- **Target:** current · branch \`${t.branch ?? "(detached)"}\` · HEAD \`${t.head_sha.slice(0, 12)}\`${t.dirty ? " · dirty (uncommitted changes included)" : ""}`,
    `- **Base:** \`${t.base_ref}\` (merge-base \`${t.merge_base.slice(0, 12)}\`)`,
    `- **Rigor:** ${context.rigor} · **Harness:** ${context.harness} · **Files changed:** ${context.files.length}`,
    `- **Lenses:** ${outcomes.map((o) => `${o.lens} (${o.status === "ok" ? o.count : o.status})`).join(", ")}`,
    `- **Verified:** ${candidates.length} of ${findings.length} finding(s) (limit ${context.limits.maxVerified})`,
    `- **Results:** ${buckets.confirmed.length} confirmed · ${buckets.judgment.length} need judgment · ${buckets.dismissed.length} dismissed${
      buckets.problems.length ? ` · ${buckets.problems.length} verification failed` : ""
    }${buckets.unverified.length ? ` · ${buckets.unverified.length} not verified (over limit)` : ""}`,
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
  if (buckets.problems.length) {
    lines.push("## Verification problems", "", "These candidates have no usable verdict and are not ranked.", "");
    for (const p of buckets.problems) {
      lines.push(
        `- \`verdicts/${p.candidate.id}.json\`: ${p.status === "missing" ? "not written" : "invalid"} · [${p.candidate.severity}] ${p.candidate.title} (\`${location(p.candidate)}\`)`,
      );
      for (const error of p.errors.slice(0, 5)) lines.push(`  - ${error}`);
      if (p.errors.length > 5) lines.push(`  - …and ${p.errors.length - 5} more`);
    }
    lines.push("");
  }
  if (!candidates.length) lines.push("No findings.", "");
  const sections = [
    ["Confirmed", buckets.confirmed, renderItem],
    ["Needs judgment", buckets.judgment, renderItem],
    ["Dismissed", buckets.dismissed, renderDismissed],
  ] as const;
  for (const [title, items, render] of sections) {
    if (!items.length) continue;
    lines.push(`## ${title} (${items.length})`, "");
    for (const item of items) lines.push(...render(item));
  }
  if (buckets.unverified.length) {
    lines.push(
      `## Not verified (${buckets.unverified.length})`,
      "",
      "Over the verification limit; unchecked reviewer output.",
      "",
    );
    for (const f of buckets.unverified) lines.push(`- [${f.severity}] ${f.title} (\`${location(f)}\`) · ${f.id}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The chat summary the agent relays: at most 10 lines. */
export function renderSummary(input: ReportInput, reportPath: string): string {
  const { outcomes, buckets } = input;
  const lines = [
    `${buckets.confirmed.length} confirmed · ${buckets.judgment.length} need judgment · ${buckets.dismissed.length} dismissed`,
  ];
  const problems = [
    ...outcomes.filter((o) => o.status !== "ok").map((o) => `reviewer ${o.lens} ${o.status}`),
    ...buckets.problems.map((p) => `verdict ${p.candidate.id} ${p.status}`),
  ];
  if (buckets.unverified.length) problems.push(`${buckets.unverified.length} finding(s) over the verification limit`);
  if (problems.length) lines.push(`problems: ${problems.join(", ")}`);
  const top = [
    ...buckets.confirmed.map((v) => ({ v, tag: v.verdict.severity_reassessed })),
    ...buckets.judgment.map((v) => ({ v, tag: `${v.verdict.severity_reassessed}, needs judgment` })),
  ];
  for (const { v, tag } of top.slice(0, 10 - lines.length - 1))
    lines.push(`- [${tag}] ${v.candidate.title} (${location(v.candidate)})`);
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
  const input = { ...collected, candidates, buckets: bucketVerdicts(runDir, candidates, collected.findings) };
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, renderReport(context, input));
  appendTrace(runDir, {
    step: "report",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    findings: collected.findings.length,
    confirmed: input.buckets.confirmed.length,
    judgment: input.buckets.judgment.length,
    dismissed: input.buckets.dismissed.length,
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
