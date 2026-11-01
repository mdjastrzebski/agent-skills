import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clusterFindings, dedup, findPossibleDuplicates, similarity, toCandidates } from "../src/dedup.js";
import type { Candidate, Finding } from "../src/schemas.js";
import { validateText } from "../src/validation.js";
import { finding } from "./fixtures.js";
import { runDir, writeFindings } from "./run-dir.js";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

let n = 0;
/** A finding with a unique id and title, at the given lines. */
function at(line_start: number, line_end = line_start, extra: Partial<Finding> = {}): Finding {
  n++;
  return {
    ...(finding as Finding),
    id: `correctness-${n}`,
    // Unique words, so unrelated test findings never look similar.
    title: `t${n}t`,
    claim: `c${n}c`,
    line_start,
    line_end,
    ...extra,
  };
}

const ids = (clusters: Finding[][]) => clusters.map((cluster) => cluster.map((f) => f.id));

describe("clusterFindings", () => {
  it("joins same file and category when ranges overlap or are at most 3 lines apart", () => {
    const [a, b, c, d] = [at(10, 12), at(12, 14), at(17), at(21)];
    // a–b overlap, b–c are 3 lines apart (14 → 17), c–d 4 lines apart (17 → 21).
    expect(ids(clusterFindings([a, b, c, d]))).toEqual([[a.id, b.id, c.id], [d.id]]);
  });

  it("links clusters transitively, keeping each cluster in input order", () => {
    // a and c are far apart, but both are near b, which comes last.
    const [a, c, b] = [at(10), at(16), at(13)];
    expect(ids(clusterFindings([a, c, b]))).toEqual([[a.id, c.id, b.id]]);
  });

  it("keeps other files and other categories apart", () => {
    const [a, b, c] = [at(10), at(10, 10, { file: "src/other.ts" }), at(10, 10, { category: "security" })];
    expect(ids(clusterFindings([a, b, c]))).toEqual([[a.id], [b.id], [c.id]]);
  });
});

describe("toCandidates", () => {
  it("merges a cluster into one candidate: most severe finding first, union of lines, all source ids", () => {
    const low = at(10, 11, { severity: "low", id: "tests-1", lens: "tests" });
    const high = at(12, 15, { severity: "high" });
    const other = at(40, 40, { severity: "medium" });
    const { candidates, findings, clusters } = toCandidates([low, other, high], 25);
    expect(findings).toBe(3);
    expect(clusters).toBe(2);
    expect(candidates).toEqual([
      { ...high, id: "c-1", line_start: 10, line_end: 15, source_ids: [high.id, "tests-1"] },
      { ...other, id: "c-2", source_ids: [other.id] },
    ]);
  });

  it("cuts clusters (not findings) to maxVerified and reports every finding left out", () => {
    const [a, b, c, d] = [at(10), at(11), at(30), at(50, 50, { severity: "low" })];
    const { candidates, overLimit } = toCandidates([a, b, c, d], 2);
    expect(candidates.map((x) => x.source_ids)).toEqual([[a.id, b.id], [c.id]]);
    expect(overLimit.map((f) => f.id)).toEqual([d.id]);
  });
});

describe("possible duplicates", () => {
  const cand = (id: string, f: Finding): Candidate => ({ ...f, id, source_ids: [f.id] });

  it("scores word overlap, ignoring case, short words and stopwords", () => {
    expect(similarity("Total ignores the discount", "total IGNORES discount")).toBe(1);
    expect(similarity("Total ignores discount", "Unrelated thing")).toBe(0);
    expect(similarity("", "")).toBe(0);
  });

  it("marks nearby findings of another category, and similar wording anywhere", () => {
    const a = cand("c-1", at(10, 10, { title: "Cart total drops discount", claim: "applyDiscount result discarded" }));
    const nearby = cand("c-2", at(20, 20, { category: "test-gap" }));
    const far = cand("c-3", at(21, 21, { category: "test-gap", file: "src/far.ts" }));
    const similar = cand(
      "c-4",
      at(90, 90, { file: "src/x.ts", title: "Cart total drops the discount", claim: "applyDiscount result discarded" }),
    );
    expect(findPossibleDuplicates([a, nearby, far, similar])).toEqual([
      { a: "c-1", b: "c-2", reason: "nearby", similarity: 0 },
      { a: "c-1", b: "c-4", reason: "similar", similarity: 1 },
    ]);
  });
});

describe("dedup", () => {
  it("writes candidates.json, one file per candidate, possible duplicates and an empty verdicts/", () => {
    const { dir } = runDir(["correctness", "security"]);
    writeFindings(dir, "correctness", [
      { ...finding, severity: "low" },
      { ...finding, id: "correctness-2", line_start: 40, line_end: 40 },
    ]);
    writeFindings(dir, "security", "{ broken");
    const { candidates, findings, possibleDuplicates } = dedup(dir);
    expect(findings).toBe(2);
    expect(candidates.map((c) => [c.id, c.source_ids, c.severity])).toEqual([
      ["c-1", ["correctness-2"], "high"],
      ["c-2", ["correctness-1"], "low"],
    ]);
    const written = readFileSync(join(dir, "candidates.json"), "utf8");
    expect(validateText("candidates", written).ok).toBe(true);
    expect(JSON.parse(written)).toEqual(candidates);
    // Each verifier's input holds exactly its own candidate.
    expect(readdirSync(join(dir, "candidates")).toSorted()).toEqual(["c-1.json", "c-2.json"]);
    expect(read(join(dir, "candidates", "c-2.json"))).toEqual(candidates[1]);
    // Same title and claim: flagged for the merger even though 28 lines apart.
    expect(read(join(dir, "possible-duplicates.json"))).toEqual(possibleDuplicates);
    expect(possibleDuplicates).toEqual([{ a: "c-1", b: "c-2", reason: "similar", similarity: 1 }]);
    expect(existsSync(join(dir, "verdicts"))).toBe(true);
  });

  it("clears verdicts from an earlier dedup, whose ids may now name other findings", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(dir, "correctness", [finding]);
    dedup(dir);
    writeFileSync(join(dir, "verdicts", "c-1.json"), "{}");
    dedup(dir);
    expect(readdirSync(join(dir, "verdicts"))).toEqual([]);
  });

  it("is byte-identical on re-runs and removes stale candidate files", () => {
    const { dir } = runDir(["correctness"]);
    const two = [finding, { ...finding, id: "correctness-2", line_start: 40, line_end: 40 }];
    writeFindings(dir, "correctness", two);
    dedup(dir);
    const first = readFileSync(join(dir, "candidates.json"), "utf8");
    writeFindings(dir, "correctness", [finding]);
    dedup(dir);
    expect(readdirSync(join(dir, "candidates"))).toEqual(["c-1.json"]);
    writeFindings(dir, "correctness", two);
    dedup(dir);
    expect(readFileSync(join(dir, "candidates.json"), "utf8")).toBe(first);
  });
});

describe("dist/dedup.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/dedup.mjs");

  it("prints merges and the candidate ids last, and refuses directories outside .review-flow/runs", () => {
    const { dir } = runDir(["correctness", "tests"]);
    writeFindings(dir, "correctness", [finding, { ...finding, id: "correctness-2", line_start: 80, line_end: 80 }]);
    writeFindings(dir, "tests", [{ ...finding, id: "tests-1", lens: "tests" }]);
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split("\n")).toEqual([
      "2 candidate(s) to verify from 3 finding(s) (1 merged as duplicates)",
      "1 possible duplicate pair(s) in possible-duplicates.json",
      "candidates: c-1 c-2",
    ]);
    const refused = spawnSync(process.execPath, [cli, tmpdir()], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refusing/);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
  });

  it("prints an empty candidate line when there are no findings", () => {
    const { dir } = runDir(["correctness"]);
    writeFileSync(join(dir, "findings", "correctness.json"), "[]");
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.stdout.trim().split("\n").at(-1)).toBe("candidates:");
  });
});
