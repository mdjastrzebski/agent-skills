import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedup } from "../src/dedup.js";
import { collectFindings, readCandidates } from "../src/findings.js";
import { renderReport, report, unverifiedFindings } from "../src/report.js";
import { score } from "../src/score.js";
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

/** findings → candidates (c-1 security-1, c-2 correctness-1, c-3 correctness-2 low at line 40). */
function setup(lenses?: string[], maxVerified?: number) {
  const run = runDir(lenses, maxVerified);
  writeFindings(run.dir, "correctness", [
    finding,
    { ...finding, id: "correctness-2", severity: "low", title: "Low one", line_start: 40, line_end: 40 },
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

describe("unverifiedFindings", () => {
  it("lists findings over the verification limit, but not ones merged into a candidate", () => {
    const run = runDir(["correctness", "tests"], 1);
    writeFindings(run.dir, "correctness", [finding, { ...finding, id: "correctness-2", line_start: 50, line_end: 50 }]);
    writeFindings(run.dir, "tests", [{ ...finding, id: "tests-1", lens: "tests" }]);
    dedup(run.dir);
    const { findings } = collectFindings(run.dir, run.context);
    expect(unverifiedFindings(findings, readCandidates(run.dir)).map((f) => f.id)).toEqual(["correctness-2"]);
  });
});

describe("renderReport", () => {
  function render(run: ReturnType<typeof setup>) {
    const collected = collectFindings(run.dir, run.context);
    const candidates = readCandidates(run.dir);
    return renderReport(run.context, {
      ...collected,
      candidates,
      ranked: score(run.dir),
      unverified: unverifiedFindings(collected.findings, candidates),
    });
  }

  it("renders header, buckets in order, score breakdown, action, verifier evidence and fix assessment", () => {
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
    expect(md).toContain(
      "run repros and checks in a throwaway worktree, never in your checkout (evidence: 0 executed, 3 traced, 0 reasoned)",
    );
    expect(md).toContain("confirmed items scoring 5 or more are fix before merge");
    expect(md).toContain("HEAD `bbbbbbbbbbbb` · dirty");
    expect(md).toContain(
      "- **Preset:** standard · **Harness:** claude · **Files changed:** 0\n- **Models:** reviewer: opus/medium · verifier: opus/medium\n",
    );
    expect(md).toContain("- **Lenses:** correctness (2), security (1), tests (missing)");
    expect(md).toContain("- **Verified:** 3 candidate(s) from 3 finding(s) (limit 25)");
    expect(md).toContain("- **Results:** 1 fix before merge · 1 needs human judgment · 0 follow-up · 1 dismissed\n");
    expect(md).toContain("- `findings/tests.json`: not written");
    const order = ["## Fix before merge (1)", "### Shell injection", "## Needs human judgment (1)", "## Dismissed (1)"];
    const positions = order.map((heading) => md.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].toSorted((a, b) => a - b)).toEqual(positions);
    expect(md).not.toContain("## Follow-up");
    expect(md).toContain(
      "`src/api.ts:3` · high (reviewer: critical) · security · user-facing · effort: trivial · c-1 (security-1)",
    );
    expect(md).toContain("**Verifier** (confirmed, traced)\n\n> Traced src/api.ts:3");
    expect(md).toContain(
      "**Score 6.12** = severity 6 (high) × confidence 0.85 (confirmed, traced) × impact 1.2 (user-facing)",
    );
    expect(md).toContain("**Action:** Fix before merging.");
    expect(md).toContain("**Score 2.52** = severity 6 (high) × confidence 0.35 (uncertain) × impact 1.2");
    expect(md).toContain("**Action:** Decide whether this is real");
    expect(md).toContain("<details><summary>Suggested fix (assessment: ok)</summary>");
    expect(md).toContain("Assessment: ok: Test passes with the fix.");
    // A fix that contains a fence gets a longer one.
    expect(md).toContain("````\n```ts\nexecFile('git', [name])\n```\n````");
    expect(md).toContain("<b>Low one</b> · <code>src/cart.ts:40</code> · c-3 (correctness-2)");
    expect(md).toContain("**Verifier** (refuted, traced)\n\n> Guarded at a.ts:4.");
  });

  it("renders follow-ups and dismisses uncertain low-severity items with their real verdict", () => {
    const run = setup();
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1", severity_reassessed: "medium" });
    writeVerdict(run.dir, "c-2", { ...traced, candidate_id: "c-2", verdict: "uncertain", severity_reassessed: "low" });
    writeVerdict(run.dir, "c-3", { ...traced, candidate_id: "c-3", verdict: "refuted" });
    const md = render(run);
    expect(md).toContain("## Follow-up (1)\n\n### Shell injection via branch name");
    expect(md).toContain("**Action:** Fix in a follow-up");
    expect(md).toContain("## Dismissed (2)");
    expect(md).toContain("**Verifier** (uncertain, traced)");
    // Within Dismissed: the uncertain item scores above the refuted one.
    expect(md.indexOf("c-2 (correctness-1)</summary>")).toBeLessThan(md.indexOf("c-3 (correctness-2)</summary>"));
  });

  it("counts executed evidence and says when the preset disabled execution", () => {
    const run = setup();
    writeVerdict(run.dir, "c-1", { ...verdict, candidate_id: "c-1" });
    writeVerdict(run.dir, "c-2", { ...traced, candidate_id: "c-2" });
    writeVerdict(run.dir, "c-3", { ...traced, candidate_id: "c-3", evidence_type: "reasoned" });
    expect(render(run)).toContain("(evidence: 1 executed, 1 traced, 1 reasoned)");
    run.context.limits.allowExecution = false;
    expect(render(run)).toContain("verifier, read-only (execution disabled by the preset)");
  });

  it("shows every source id of a merged candidate", () => {
    const run = runDir(["correctness", "tests"]);
    writeFindings(run.dir, "correctness", [finding]);
    writeFindings(run.dir, "tests", [{ ...finding, id: "tests-1", lens: "tests", line_start: 12, line_end: 14 }]);
    dedup(run.dir);
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1" });
    const md = render(run);
    expect(md).toContain("- **Verified:** 1 candidate(s) from 2 finding(s)");
    expect(md).toContain(
      "`src/cart.ts:10-14` · high · bug · user-facing · effort: trivial · c-1 (correctness-1, tests-1)",
    );
  });

  it("HTML-escapes dismissed titles, which sit inside raw HTML", () => {
    const run = runDir(["correctness"]);
    writeFindings(run.dir, "correctness", [{ ...finding, title: "Unsafe <b>&</b> title" }]);
    dedup(run.dir);
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1", verdict: "refuted" });
    const md = render(run);
    expect(md).toContain("<summary><b>Unsafe &lt;b&gt;&amp;&lt;/b&gt; title</b>");
    expect(md).not.toContain("<b>&</b>");
  });

  it("lists verification problems and unverified findings separately", () => {
    const run = setup(undefined, 2);
    writeVerdict(run.dir, "c-1", { ...traced, candidate_id: "c-1" });
    const md = render(run);
    expect(md).toContain("· 1 verification failed · 1 not verified (over limit)");
    expect(md).toContain("## Verification problems");
    expect(md).toContain("- `verdicts/c-2.json`: not written · [high] Total ignores discounts (`src/cart.ts:10-12`)");
    expect(md).toContain("## Not verified (1)");
    expect(md).toContain("- [low] Low one (`src/cart.ts:40`) · correctness-2");
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
    writeVerdict(dir, "c-3", { ...traced, candidate_id: "c-3", severity_reassessed: "low" });
    score(dir);
    const first = report(dir);
    const firstText = readFileSync(first.reportPath, "utf8");
    score(dir);
    report(dir);
    expect(readFileSync(first.reportPath, "utf8")).toBe(firstText);
    expect(first.summary.split("\n")).toEqual([
      "1 fix before merge · 1 needs human judgment · 1 follow-up · 0 dismissed · evidence: 0 executed, 3 traced, 0 reasoned",
      "- [fix, critical, 10.2] Shell injection via branch name (src/api.ts:3)",
      "- [needs judgment, high, 2.52] Total ignores discounts (src/cart.ts:10-12)",
      "- [follow-up, low, 1.02] Low one (src/cart.ts:40)",
      join(dir, "report.md"),
    ]);
  });

  it("flags problems in the summary and caps it at 10 lines", () => {
    const { dir } = runDir(["correctness", "tests"]);
    writeFindings(
      dir,
      "correctness",
      Array.from({ length: 20 }, (_, i) => ({
        ...finding,
        id: `correctness-${i + 1}`,
        line_start: 10 * (i + 1),
        line_end: 10 * (i + 1),
      })),
    );
    dedup(dir);
    for (let i = 1; i <= 19; i++) writeVerdict(dir, `c-${i}`, { ...traced, candidate_id: `c-${i}` });
    score(dir);
    const lines = report(dir).summary.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[1]).toBe("problems: reviewer tests missing, verdict c-20 missing");
  });

  it("refuses a run directory without context.json, candidates.json or ranked.json", () => {
    const { dir } = runDir();
    expect(() => report(dir)).toThrow(/candidates\.json not found: run dedup\.mjs first/);
    writeFileSync(join(dir, "candidates.json"), "{ broken");
    expect(() => report(dir)).toThrow(/candidates\.json is invalid: \(root\): invalid JSON/);
    writeFileSync(join(dir, "candidates.json"), "[]");
    expect(() => report(dir)).toThrow(/ranked\.json not found: run score\.mjs first/);
    rmSync(join(dir, "context.json"));
    expect(() => report(dir)).toThrow(/cannot read .*context\.json/);
  });

  it("refuses a ranked.json from an earlier dedup", () => {
    const { dir } = setup();
    score(dir);
    writeFindings(dir, "security", []);
    dedup(dir);
    expect(() => report(dir)).toThrow(/does not match candidates\.json/);
  });
});

describe("dist/report.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/report.mjs");

  it("prints the report path last, and refuses directories outside .review-flow/runs", () => {
    const { dir } = setup(["correctness", "security"]);
    score(dir);
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split("\n").at(-1)).toBe(join(dir, "report.md"));
    const refused = spawnSync(process.execPath, [cli, tmpdir()], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refusing/);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
  });
});
