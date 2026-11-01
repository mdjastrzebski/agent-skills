import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "../src/context.js";
import { collectFindings, renderReport, report } from "../src/report.js";
import { finding } from "./fixtures.js";

/** A fake run directory inside a real git repo, so the run-dir guard accepts it. */
function runDir(lenses = ["correctness", "security", "tests"]): { dir: string; context: Context } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-flow-report-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const dir = join(root, ".review-flow/runs/current-20261101-123456");
  mkdirSync(join(dir, "findings"), { recursive: true });
  const context = {
    version: 1,
    run_id: "current-20261101-123456",
    run_dir: dir,
    created_at: "2026-11-01T12:34:56.000Z",
    harness: "claude",
    skill_dir: "/skill",
    repo_root: root,
    code_root: root,
    target: {
      mode: "current",
      branch: "feature",
      base: "main",
      base_ref: "origin/main",
      merge_base: "a".repeat(40),
      head_sha: "b".repeat(40),
      dirty: true,
    },
    rigor: "medium",
    limits: { maxVerified: 25, parallel: 4, allowExecution: true },
    models: { reviewer: "sonnet", merger: "haiku", verifier: "opus" },
    lenses: lenses.map((name) => ({
      name,
      prompt: `/skill/prompts/lenses/${name}.md`,
      output: `findings/${name}.json`,
    })),
    specs: [],
    stack: null,
    checks: { typecheck: null, test: null },
    ignore: [],
    diff: "diff.patch",
    files: [],
  } satisfies Context;
  writeFileSync(join(dir, "context.json"), JSON.stringify(context));
  return { dir, context };
}

function writeFindings(dir: string, lens: string, value: unknown) {
  writeFileSync(join(dir, "findings", `${lens}.json`), typeof value === "string" ? value : JSON.stringify(value));
}

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

describe("reviewer problems", () => {
  it("lists invalid files with at most 5 errors, and flags them in the summary", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(
      dir,
      "correctness",
      Array.from({ length: 7 }, (_, i) => ({ ...finding, id: `correctness-${i + 1}`, severity: "major" })),
    );
    const { reportPath, summary } = report(dir);
    const md = readFileSync(reportPath, "utf8");
    expect(md).toContain("- `findings/correctness.json`: invalid, skipped");
    expect(md.match(/^  - \[\d\]\.severity: /gm)).toHaveLength(5);
    expect(md).toContain("  - …and 2 more");
    expect(summary.split("\n")).toContain("reviewer problems: correctness invalid");
  });

  it("refuses a run directory without a readable context.json", () => {
    const { dir } = runDir();
    rmSync(join(dir, "context.json"));
    expect(() => report(dir)).toThrow(/cannot read .*context\.json/);
  });
});

describe("renderReport", () => {
  it("groups by severity then file, with header, problems and fixes", () => {
    const { dir, context } = runDir();
    writeFindings(dir, "correctness", [
      finding,
      { ...finding, id: "correctness-2", file: "src/a.ts", severity: "high" },
    ]);
    writeFindings(dir, "security", [security]);
    const md = renderReport(context, collectFindings(dir, context));
    expect(md).toMatch(/^# Review: feature \(current\)\n/);
    expect(md).toContain("**unverified**");
    expect(md).toContain("HEAD `bbbbbbbbbbbb` · dirty");
    expect(md).toContain("- **Base:** `origin/main` (merge-base `aaaaaaaaaaaa`)");
    expect(md).toContain("- **Lenses:** correctness (2), security (1), tests (missing)");
    expect(md).toContain("- **Findings:** 3 (1 critical, 2 high)");
    expect(md).toContain("- `findings/tests.json`: not written");
    const order = ["## Critical (1)", "### `src/api.ts`", "## High (2)", "### `src/a.ts`", "### `src/cart.ts`"];
    const positions = order.map((heading) => md.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].toSorted((a, b) => a - b)).toEqual(positions);
    expect(md).toContain("`src/cart.ts:10-12` · bug · correctness-1");
    // A fix that contains a fence gets a longer one.
    expect(md).toContain("````\n```ts\nexecFile('git', [name])\n```\n````");
  });

  it("says so when there are no findings", () => {
    const { dir, context } = runDir(["correctness"]);
    writeFindings(dir, "correctness", []);
    expect(renderReport(context, collectFindings(dir, context))).toContain("\nNo findings.\n");
  });
});

describe("report", () => {
  it("writes report.md byte-identically on re-runs and returns a short summary", () => {
    const { dir } = runDir();
    writeFindings(dir, "correctness", [finding]);
    writeFindings(dir, "security", [security]);
    const first = report(dir);
    const firstText = readFileSync(first.reportPath, "utf8");
    report(dir);
    expect(readFileSync(first.reportPath, "utf8")).toBe(firstText);
    const lines = first.summary.split("\n");
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toBe("2 unverified finding(s): 1 critical · 1 high · 0 medium · 0 low");
    expect(lines).toContain("- [critical] Shell injection via branch name (src/api.ts:3)");
    expect(lines.at(-1)).toBe(join(dir, "report.md"));
  });

  it("caps the summary at 10 lines", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(
      dir,
      "correctness",
      Array.from({ length: 20 }, (_, i) => ({ ...finding, id: `correctness-${i + 1}` })),
    );
    expect(report(dir).summary.split("\n")).toHaveLength(10);
  });
});

describe("dist/report.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/report.mjs");

  it("prints the report path last, and refuses directories outside .review-flow/runs", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(dir, "correctness", [finding]);
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split("\n").at(-1)).toBe(join(dir, "report.md"));
    const refused = spawnSync(process.execPath, [cli, tmpdir()], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refusing/);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
  });
});
