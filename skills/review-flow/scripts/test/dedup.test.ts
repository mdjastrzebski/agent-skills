import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedup } from "../src/dedup.js";
import { validateText } from "../src/validation.js";
import { finding } from "./fixtures.js";
import { runDir, writeFindings } from "./run-dir.js";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("dedup (stub)", () => {
  it("makes one candidate per valid finding, ordered by severity, with a file per candidate", () => {
    const { dir } = runDir(["correctness", "security"]);
    writeFindings(dir, "correctness", [
      { ...finding, severity: "low" },
      { ...finding, id: "correctness-2" },
    ]);
    writeFindings(dir, "security", "{ broken");
    const { candidates, findings, overLimit } = dedup(dir);
    expect(findings).toBe(2);
    expect(overLimit).toEqual([]);
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
    expect(existsSync(join(dir, "verdicts"))).toBe(true);
  });

  it("cuts to limits.maxVerified and reports the rest", () => {
    const { dir } = runDir(["correctness"], 2);
    writeFindings(
      dir,
      "correctness",
      Array.from({ length: 3 }, (_, i) => ({
        ...finding,
        id: `correctness-${i + 1}`,
        line_start: 10 + i,
        line_end: 10 + i,
      })),
    );
    const { candidates, overLimit } = dedup(dir);
    expect(candidates.map((c) => c.source_ids[0])).toEqual(["correctness-1", "correctness-2"]);
    expect(overLimit.map((f) => f.id)).toEqual(["correctness-3"]);
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
    writeFindings(dir, "correctness", [finding, { ...finding, id: "correctness-2" }]);
    dedup(dir);
    const first = readFileSync(join(dir, "candidates.json"), "utf8");
    writeFindings(dir, "correctness", [finding]);
    dedup(dir);
    expect(readdirSync(join(dir, "candidates"))).toEqual(["c-1.json"]);
    writeFindings(dir, "correctness", [finding, { ...finding, id: "correctness-2" }]);
    dedup(dir);
    expect(readFileSync(join(dir, "candidates.json"), "utf8")).toBe(first);
  });
});

describe("dist/dedup.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/dedup.mjs");

  it("prints the candidate ids last, and refuses directories outside .review-flow/runs", () => {
    const { dir } = runDir(["correctness"]);
    writeFindings(dir, "correctness", [finding, { ...finding, id: "correctness-2" }]);
    const ok = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split("\n")).toEqual(["2 candidate(s) to verify from 2 finding(s)", "candidates: c-1 c-2"]);
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
