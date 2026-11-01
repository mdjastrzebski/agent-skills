/**
 * Report (walking skeleton): turns `findings/*.json` into `report.md`, grouped by severity, then file.
 * Findings are unverified at this stage; verification, scoring and buckets come later.
 *
 * Usage: node scripts/dist/report.mjs <runDir>
 *
 * Prints a short summary (counts and top items), then the report path as the last line of stdout.
 * Output depends only on the run directory's files, so re-runs are byte-identical.
 * Exit 0 on success (also when some findings files are invalid; the report lists them), 2 on usage errors.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntry } from "./cli.js";
import { type Context, readContext } from "./context.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import { type Finding, SEVERITIES } from "./schemas.js";
import { validateText } from "./validation.js";

export type LensOutcome = {
  lens: string;
  file: string;
  status: "ok" | "missing" | "invalid";
  count: number;
  errors: string[];
};

export type Collected = { findings: Finding[]; outcomes: LensOutcome[] };

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index]));

function compareFindings(a: Finding, b: Finding): number {
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

/** A code fence longer than any backtick run inside `text`. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

function location(finding: Finding): string {
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

function renderFinding(finding: Finding): string[] {
  const lines = [
    `#### ${finding.title}`,
    "",
    `\`${location(finding)}\` · ${finding.category} · ${finding.id}`,
    "",
    finding.claim.trim(),
    "",
    "**Evidence**",
    "",
    quote(finding.evidence),
    "",
  ];
  if (finding.suggested_fix) {
    const fix = finding.suggested_fix.trim();
    const isDiff = /^(diff --git|--- |@@ )/m.test(fix);
    const marks = fence(fix);
    lines.push(
      "<details><summary>Suggested fix</summary>",
      "",
      `${marks}${isDiff ? "diff" : ""}`,
      fix,
      marks,
      "",
      "</details>",
      "",
    );
  }
  return lines;
}

export function renderReport(context: Context, collected: Collected): string {
  const { findings, outcomes } = collected;
  const t = context.target;
  const counts = SEVERITIES.map(
    (severity) => [severity, findings.filter((f) => f.severity === severity).length] as const,
  );
  const lines = [
    `# Review: ${t.branch ?? "detached HEAD"} (current)`,
    "",
    "> ⚠️ Findings are **unverified** reviewer output. Independent verification is not implemented yet.",
    "",
    `- **Target:** current · branch \`${t.branch ?? "(detached)"}\` · HEAD \`${t.head_sha.slice(0, 12)}\`${t.dirty ? " · dirty (uncommitted changes included)" : ""}`,
    `- **Base:** \`${t.base_ref}\` (merge-base \`${t.merge_base.slice(0, 12)}\`)`,
    `- **Rigor:** ${context.rigor} · **Harness:** ${context.harness} · **Files changed:** ${context.files.length}`,
    `- **Lenses:** ${outcomes.map((o) => `${o.lens} (${o.status === "ok" ? o.count : o.status})`).join(", ")}`,
    `- **Findings:** ${findings.length}${
      findings.length
        ? ` (${counts
            .filter(([, n]) => n)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ")})`
        : ""
    }`,
    "",
  ];
  const problems = outcomes.filter((o) => o.status !== "ok");
  if (problems.length) {
    lines.push("## Reviewer problems", "");
    for (const o of problems) {
      lines.push(
        `- \`${o.file}\`: ${o.status === "missing" ? "not written (reviewer failed or did not finish)" : "invalid, skipped"}`,
      );
      for (const error of o.errors.slice(0, 5)) lines.push(`  - ${error}`);
      if (o.errors.length > 5) lines.push(`  - …and ${o.errors.length - 5} more`);
    }
    lines.push("");
  }
  if (!findings.length) lines.push("No findings.", "");
  for (const [severity, count] of counts) {
    if (!count) continue;
    lines.push(`## ${severity[0].toUpperCase()}${severity.slice(1)} (${count})`, "");
    let file: string | undefined;
    for (const finding of findings.filter((f) => f.severity === severity)) {
      if (finding.file !== file) {
        file = finding.file;
        lines.push(`### \`${file}\``, "");
      }
      lines.push(...renderFinding(finding));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The chat summary the agent relays: at most 10 lines. */
export function renderSummary(context: Context, collected: Collected, reportPath: string): string {
  const { findings, outcomes } = collected;
  const counts = SEVERITIES.map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(" · ");
  const lines = [`${findings.length} unverified finding(s): ${counts}`];
  const problems = outcomes.filter((o) => o.status !== "ok");
  if (problems.length) lines.push(`reviewer problems: ${problems.map((o) => `${o.lens} ${o.status}`).join(", ")}`);
  for (const finding of findings.slice(0, 10 - lines.length - 1))
    lines.push(`- [${finding.severity}] ${finding.title} (${location(finding)})`);
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
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, renderReport(context, collected));
  appendTrace(runDir, {
    step: "report",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    findings: collected.findings.length,
  });
  return { reportPath, summary: renderSummary(context, collected, reportPath) };
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
