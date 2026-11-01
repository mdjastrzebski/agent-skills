import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDefaults } from "../src/config.js";
import { dedup } from "../src/dedup.js";
import { score } from "../src/score.js";
import { bucketOf, compareRanked, type Ranked, readRanked, scoreVerdict } from "../src/scoring.js";
import type { Candidate, Verdict } from "../src/schemas.js";
import { candidate, finding, verdict } from "./fixtures.js";
import { runDir, writeFindings, writeVerdict } from "./run-dir.js";

const scoring = loadDefaults().scoring;
const v = (extra: Partial<Verdict>): Verdict => ({ ...(verdict as Verdict), ...extra });

describe("scoreVerdict (§8 weights)", () => {
  it("multiplies severity, confidence and impact", () => {
    expect(scoreVerdict(v({}), scoring)).toEqual({
      score: 7.2,
      breakdown: { severity: 6, confidence: 1, impact: 1.2 },
    });
    expect(scoreVerdict(v({ evidence_type: "traced", impact: "internal" }), scoring).score).toBe(4.59);
    expect(scoreVerdict(v({ evidence_type: "reasoned", severity_reassessed: "critical" }), scoring).score).toBe(7.8);
    expect(scoreVerdict(v({ verdict: "uncertain", severity_reassessed: "low" }), scoring).score).toBe(0.42);
    expect(scoreVerdict(v({ verdict: "refuted", severity_reassessed: "critical" }), scoring).score).toBe(0);
  });

  it("uses the weights it is given", () => {
    const tuned = { ...scoring, severity: { ...scoring.severity, high: 2 } };
    expect(scoreVerdict(v({}), tuned).score).toBe(2.4);
  });
});

describe("bucketOf", () => {
  const bucket = (extra: Partial<Verdict>) => {
    const value = v(extra);
    return bucketOf(value, scoreVerdict(value, scoring).score, scoring);
  };

  it("applies the §8 bucket rules", () => {
    expect(bucket({ verdict: "refuted", severity_reassessed: "critical" })).toBe("dismissed");
    expect(bucket({ verdict: "uncertain", severity_reassessed: "critical" })).toBe("judgment");
    expect(bucket({ verdict: "uncertain", severity_reassessed: "high" })).toBe("judgment");
    expect(bucket({ verdict: "uncertain", severity_reassessed: "medium" })).toBe("dismissed");
    // high × traced × user-facing = 6.12 ≥ 5; medium × executed × user-facing = 3.6 < 5.
    expect(bucket({ evidence_type: "traced" })).toBe("fix");
    expect(bucket({ severity_reassessed: "medium" })).toBe("follow-up");
  });

  it("puts a score exactly at the threshold in fix before merge", () => {
    expect(bucketOf(v({}), 5, scoring)).toBe("fix");
    expect(bucketOf(v({}), 4.999, scoring)).toBe("follow-up");
  });
});

describe("compareRanked", () => {
  const item = (
    id: string,
    bucket: Ranked["bucket"],
    value: number,
    extra: Partial<Verdict> = {},
    file = "a.ts",
    at: Partial<Candidate> = {},
  ) =>
    ({
      candidate: { ...(candidate as Candidate), id, file, ...at },
      verdict: v(extra),
      bucket,
      score: value,
      breakdown: { severity: 0, confidence: 0, impact: 0 },
    }) satisfies Ranked;

  it("orders by bucket, then score, then effort (cheaper first), then file path", () => {
    const items = [
      item("c-1", "follow-up", 9),
      item("c-2", "fix", 5, { effort: "large" }),
      item("c-3", "fix", 5, { effort: "small" }, "z.ts"),
      item("c-4", "fix", 5, { effort: "small" }, "b.ts"),
      item("c-5", "fix", 7),
      item("c-6", "judgment", 2),
    ];
    expect(items.toSorted(compareRanked).map((i) => i.candidate.id)).toEqual([
      "c-5",
      "c-4",
      "c-3",
      "c-2",
      "c-6",
      "c-1",
    ]);
  });

  it("breaks the last ties by line within a file, ignoring the reviewer's severity", () => {
    const late = item("c-1", "fix", 5, {}, "a.ts", { severity: "critical", line_start: 30, line_end: 30 });
    const early = item("c-2", "fix", 5, {}, "a.ts", { severity: "low", line_start: 10, line_end: 10 });
    expect([late, early].toSorted(compareRanked).map((i) => i.candidate.id)).toEqual(["c-2", "c-1"]);
  });
});

describe("score", () => {
  /** Three findings far apart → c-1 (lines 10-12), c-2 (40), c-3 (70). */
  function setup() {
    const run = runDir(["correctness"]);
    writeFindings(
      run.dir,
      "correctness",
      [10, 40, 70].map((line, i) => ({
        ...finding,
        id: `correctness-${i + 1}`,
        title: `t${i}t`,
        line_start: line,
        line_end: line,
      })),
    );
    dedup(run.dir);
    return run;
  }

  it("writes ranked.json with scores, buckets and problems, byte-identical on re-runs", () => {
    const { dir } = setup();
    writeVerdict(dir, "c-1", { ...verdict, candidate_id: "c-1", severity_reassessed: "low" });
    writeVerdict(dir, "c-2", { ...verdict, candidate_id: "c-2" });
    writeVerdict(dir, "c-3", { ...verdict, candidate_id: "c-1" });
    const ranked = score(dir);
    const text = readFileSync(join(dir, "ranked.json"), "utf8");
    expect(JSON.parse(text)).toEqual(ranked);
    expect(ranked.scoring).toEqual(scoring);
    expect(ranked.items.map((i) => [i.candidate.id, i.bucket, i.score])).toEqual([
      ["c-2", "fix", 7.2],
      ["c-1", "follow-up", 1.2],
    ]);
    expect(ranked.problems.map((p) => [p.candidate.id, p.status, p.errors])).toEqual([
      ["c-3", "invalid", ['candidate_id: expected "c-3", got "c-1"']],
    ]);
    score(dir);
    expect(readFileSync(join(dir, "ranked.json"), "utf8")).toBe(text);
    const trace = readFileSync(join(dir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(trace.at(-1)).toMatchObject({ step: "score", fix: 1, "follow-up": 1, problems: 1 });
  });

  it("scores with the weights recorded in context.json", () => {
    const { dir, context } = setup();
    writeFileSync(
      join(dir, "context.json"),
      JSON.stringify({ ...context, scoring: { ...scoring, fixBeforeMergeThreshold: 100 } }),
    );
    writeVerdict(dir, "c-2", { ...verdict, candidate_id: "c-2" });
    expect(score(dir).items.map((i) => i.bucket)).toEqual(["follow-up"]);
  });

  it("readRanked refuses a missing, corrupt or stale ranked.json", () => {
    const { dir } = setup();
    const candidates = JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8"));
    expect(() => readRanked(dir, candidates)).toThrow(/run score\.mjs first/);
    writeFileSync(join(dir, "ranked.json"), "{ broken");
    expect(() => readRanked(dir, candidates)).toThrow(/ranked\.json is invalid/);
    for (const shape of [
      { version: 2, items: [], problems: [] },
      { version: 1, items: {}, problems: [] },
    ]) {
      writeFileSync(join(dir, "ranked.json"), JSON.stringify(shape));
      expect(() => readRanked(dir, candidates)).toThrow(/is invalid: re-run score\.mjs/);
    }
    score(dir);
    expect(readRanked(dir, candidates).problems).toHaveLength(3);
    expect(() => readRanked(dir, candidates.slice(1))).toThrow(/does not match candidates\.json/);
  });

  it("needs candidates.json and scoring weights", () => {
    const { dir, context } = setup();
    rmSync(join(dir, "candidates.json"));
    expect(() => score(dir)).toThrow(/run dedup\.mjs first/);
    const { scoring: _, ...withoutScoring } = context;
    writeFileSync(join(dir, "context.json"), JSON.stringify(withoutScoring));
    expect(() => score(dir)).toThrow(/no scoring weights/);
  });
});

describe("dist/score.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/score.mjs");

  it("prints bucket counts, and refuses directories outside .review-flow/runs", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(dir, "correctness", [finding]);
    dedup(dir);
    writeVerdict(dir, "c-1", { ...verdict, verdict: "uncertain" });
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe("0 fix before merge · 1 needs human judgment · 0 follow-up · 0 dismissed");
    const refused = spawnSync(process.execPath, [cli, tmpdir()], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refusing/);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
  });
});
