import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedup } from "../src/dedup.js";
import { collectFindings } from "../src/findings.js";
import { bucketVerdicts, readCandidates, renderReport, report } from "../src/report.js";
import { finding, verdict } from "./fixtures.js";
import { runDir, writeFindings, writeVerdict } from "./run-dir.js";

const security = {
  ...finding,
  id: "security-1",
  lens: "security",
  file: "src/api.ts",
  line_start: 3,
  line_end: 3,
  category: "security",
  severity: "critical",
  title: "Shell injection via branch name",
  suggested_fix: "```ts\nexecFile('git', [name])\n```",
};

const traced = { ...verdict, evidence_type: "traced", evidence: "Traced src/api.ts:3 → exec(`git ${name}`)." };

/** findings → candidates (c-1 security-1, c-2 correctness-1, c-3 correctness-2 low). */
function setup(lenses?: string[], maxVerified?: number) {
  const run = runDir(lenses, maxVerified);
  writeFindings(run.dir, "correctness", [
    finding,
    { ...finding, id: "correctness-2", severity: "low", title: "Low one" },
  ]);
  writeFindings(run.dir, "security", [security]);
  dedup(run.dir);
  return run;
}

describe("collectFindings", () => {
  it("validates each lens file and sorts by severity, file, line", () => {
    const { dir, context } = runDir();
    writeFindings(dir, "correctness", [
      { ...finding, id: "correctness-2", file: "src/a.ts", severity: "low" },
      finding,
      { ...finding, id: "correctness-3", line_start: 2, line_end: 2 },
    ]);
    writeFindings(dir, "security", [security]);
    writeFindings(dir, "tests", "{ broken");
    writeFindings(dir, "extra", []);
    const { findings, outcomes } = collectFindings(dir, context);
    expect(findings.map((f) => f.id)).toEqual(["security-1", "correctness-3", "correctness-1", "correctness-2"]);
    expect(outcomes.map((o) => [o.lens, o.status, o.count])).toEqual([
      ["correctness", "ok", 3],
      ["security", "ok", 1],
      ["tests", "invalid", 0],
      ["extra", "ok", 0],
    ]);
  });

  it("marks lenses with no output as missing", () => {
    const { dir, context } = runDir(["correctness"]);
    expect(collectFindings(dir, context).outcomes).toEqual([
      { lens: "correctness", file: "findings/correctness.json", status: "missing", count: 0, errors: [] },
    ]);
  });
});

describe("bucketVerdicts", () => {
  it("puts confirmed first, uncertain in judgment, refuted in dismissed, ordered by reassessed severity", () => {
    const { dir, context } = setup();
    writeVerdict(dir, "c-1", { ...traced, candidate_id: "c-1", verdict: "refuted" });
    writeVerdict(dir, "c-2", {
      ...traced,
      candidate_id: "c-2",
      severity_reassessed: "medium",
      evidence_type: "reasoned",
    });
    writeVerdict(dir, "c-3", { ...traced, candidate_id: "c-3", severity_reassessed: "medium" });
    const candidates = readCandidates(dir);
    const buckets = bucketVerdicts(dir, candidates, collectFindings(dir, context).findings);
    // Same reassessed severity: traced beats reasoned.
    expect(buckets.confirmed.map((v) => v.candidate.id)).toEqual(["c-3", "c-2"]);
    expect(buckets.judgment).toEqual([]);
    expect(buckets.dismissed.map((v) => v.candidate.id)).toEqual(["c-1"]);
    expect(buckets.problems).toEqual([]);
    expect(buckets.unverified).toEqual([]);
  });

  it("reports missing, invalid and mismatched verdicts as problems, never as ranked items", () => {
    const { dir, context } = setup();
    writeVerdict(dir, "c-1", { ...traced, candidate_id: "c-2" });
    writeVerdict(dir, "c-2", { ...traced, candidate_id: "c-2", verdict: "maybe" });
    const buckets = bucketVerdicts(dir, readCandidates(dir), collectFindings(dir, context).findings);
    expect(buckets.problems.map((p) => [p.candidate.id, p.status])).toEqual([
      ["c-1", "invalid"],
      ["c-2", "invalid"],
      ["c-3", "missing"],
    ]);
    expect(buckets.problems[0].errors).toEqual(['candidate_id: expected "c-1", got "c-2"']);
    expect([...buckets.confirmed, ...buckets.judgment, ...buckets.dismissed]).toEqual([]);
  });

  it("lists findings over the verification limit as unverified", () => {
    const { dir, context } = setup(undefined, 2);
    const buckets = bucketVerdicts(dir, readCandidates(dir), collectFindings(dir, context).findings);
    expect(buckets.unverified.map((f) => f.id)).toEqual(["correctness-2"]);
  });
});

describe("renderReport", () => {
  function render(run: ReturnType<typeof setup>) {
    const collected = collectFindings(run.dir, run.context);
    const candidates = readCandidates(run.dir);
    return renderReport(run.context, {
      ...collected,
      candidates,
      buckets: bucketVerdicts(run.dir, candidates, collected.findings),
    });
  }

  it("renders header, buckets in order, verifier evidence and fix assessment", () => {
    const run = setup();
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1", severity_reassessed: "high" });
    writeVerdict(run.dir, "c-2", { ...traced, candidate_id: "c-2", verdict: "uncertain" });
    writeVerdict(run.dir, "c-3", {
      ...traced,
      candidate_id: "c-3",
      verdict: "refuted",
      evidence: "Guarded at a.ts:4.",
    });
    const md = render(run);
    expect(md).toMatch(/^# Review: feature \(current\)\n/);
    expect(md).toContain("independent, read-only verifier");
    expect(md).toContain("HEAD `bbbbbbbbbbbb` · dirty");
    expect(md).toContain("- **Lenses:** correctness (2), security (1), tests (missing)");
    expect(md).toContain("- **Verified:** 3 of 3 finding(s) (limit 25)");
    expect(md).toContain("- **Results:** 1 confirmed · 1 need judgment · 1 dismissed\n");
    expect(md).toContain("- `findings/tests.json`: not written");
    const order = ["## Confirmed (1)", "### Shell injection", "## Needs judgment (1)", "## Dismissed (1)"];
    const positions = order.map((heading) => md.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].toSorted((a, b) => a - b)).toEqual(positions);
    expect(md).toContain(
      "`src/api.ts:3` · high (reviewer: critical) · security · user-facing · effort: trivial · c-1 (security-1)",
    );
    expect(md).toContain("**Verifier** (confirmed, traced)\n\n> Traced src/api.ts:3");
    expect(md).toContain("<details><summary>Suggested fix (assessment: ok)</summary>");
    expect(md).toContain("Assessment: ok: Test passes with the fix.");
    // A fix that contains a fence gets a longer one.
    expect(md).toContain("````\n```ts\nexecFile('git', [name])\n```\n````");
    expect(md).toContain("<b>Low one</b> · <code>src/cart.ts:10-12</code> · c-3 (correctness-2)");
    expect(md).toContain("**Verifier** (refuted, traced)\n\n> Guarded at a.ts:4.");
  });

  it("lists verification problems and unverified findings separately", () => {
    const run = setup(undefined, 2);
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1" });
    const md = render(run);
    expect(md).toContain("· 1 verification failed · 1 not verified (over limit)");
    expect(md).toContain("## Verification problems");
    expect(md).toContain("- `verdicts/c-2.json`: not written · [high] Total ignores discounts (`src/cart.ts:10-12`)");
    expect(md).toContain("## Not verified (1)");
    expect(md).toContain("- [low] Low one (`src/cart.ts:10-12`) · correctness-2");
  });

  it("says so when there are no findings", () => {
    const run = runDir(["correctness"]);
    writeFindings(run.dir, "correctness", []);
    dedup(run.dir);
    expect(render(run)).toContain("\nNo findings.\n");
  });
});

describe("report", () => {
  it("writes report.md byte-identically on re-runs and returns a short summary", () => {
    const { dir } = setup(["correctness", "security"]);
    writeVerdict(dir, "c-1", { ...traced, candidate_id: "c-1", severity_reassessed: "critical" });
    writeVerdict(dir, "c-2", { ...traced, candidate_id: "c-2", verdict: "uncertain" });
    writeVerdict(dir, "c-3", { ...traced, candidate_id: "c-3", verdict: "refuted" });
    const first = report(dir);
    const firstText = readFileSync(first.reportPath, "utf8");
    report(dir);
    expect(readFileSync(first.reportPath, "utf8")).toBe(firstText);
    expect(first.summary.split("\n")).toEqual([
      "1 confirmed · 1 need judgment · 1 dismissed",
      "- [critical] Shell injection via branch name (src/api.ts:3)",
      "- [high, needs judgment] Total ignores discounts (src/cart.ts:10-12)",
      join(dir, "report.md"),
    ]);
  });

  it("flags problems in the summary and caps it at 10 lines", () => {
    const { dir } = runDir(["correctness", "tests"]);
    writeFindings(
      dir,
      "correctness",
      Array.from({ length: 20 }, (_, i) => ({ ...finding, id: `correctness-${i + 1}` })),
    );
    dedup(dir);
    for (let i = 1; i <= 19; i++) writeVerdict(dir, `c-${i}`, { ...traced, candidate_id: `c-${i}` });
    const lines = report(dir).summary.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[1]).toBe("problems: reviewer tests missing, verdict c-20 missing");
  });

  it("refuses a run directory without context.json or candidates.json", () => {
    const { dir } = runDir();
    expect(() => report(dir)).toThrow(/candidates\.json not found: run dedup\.mjs first/);
    rmSync(join(dir, "context.json"));
    expect(() => report(dir)).toThrow(/cannot read .*context\.json/);
  });
});

describe("dist/report.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/report.mjs");

  it("prints the report path last, and refuses directories outside .review-flow/runs", () => {
    const { dir } = setup(["correctness", "security"]);
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split("\n").at(-1)).toBe(join(dir, "report.md"));
    const refused = spawnSync(process.execPath, [cli, tmpdir()], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refusing/);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
  });
});
