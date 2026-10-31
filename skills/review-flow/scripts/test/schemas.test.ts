import { describe, expect, it } from "vitest";
import { Candidate, CandidateList, Finding, FindingList, Verdict } from "../src/schemas.js";
import { candidate, finding, verdict } from "./fixtures.js";

describe("Finding", () => {
  it("accepts a valid finding, with or without suggested_fix", () => {
    expect(Finding.safeParse(finding).success).toBe(true);
    const { suggested_fix, ...withoutFix } = finding;
    expect(Finding.safeParse(withoutFix).success).toBe(true);
  });

  it.each([
    ["unknown category", { category: "style" }],
    ["unknown severity", { severity: "major" }],
    ["title over 80 chars", { title: "x".repeat(81) }],
    ["line 0", { line_start: 0 }],
    ["fractional line", { line_end: 10.5 }],
    ["line_end before line_start", { line_start: 20, line_end: 12 }],
    ["id not <lens>-<n>", { id: "security-1" }],
    ["non-kebab lens", { lens: "React Native", id: "React Native-1" }],
    ["empty claim", { claim: "" }],
    ["unknown key", { confidence: 0.9 }],
  ])("rejects %s", (_, patch) => {
    expect(Finding.safeParse({ ...finding, ...patch }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { evidence, ...rest } = finding;
    expect(Finding.safeParse(rest).success).toBe(false);
  });

  it("rejects duplicate ids in a list", () => {
    expect(FindingList.safeParse([finding, { ...finding, id: "correctness-2" }]).success).toBe(true);
    expect(FindingList.safeParse([finding, finding]).success).toBe(false);
  });
});

describe("Candidate", () => {
  it("accepts a valid candidate with a free-form id", () => {
    expect(Candidate.safeParse(candidate).success).toBe(true);
  });

  it("requires non-empty source_ids", () => {
    expect(Candidate.safeParse({ ...candidate, source_ids: [] }).success).toBe(false);
    const { source_ids, ...rest } = candidate;
    expect(Candidate.safeParse(rest).success).toBe(false);
  });

  it("still checks line ranges and unique ids", () => {
    expect(Candidate.safeParse({ ...candidate, line_end: 1 }).success).toBe(false);
    expect(CandidateList.safeParse([candidate, candidate]).success).toBe(false);
  });
});

describe("Verdict", () => {
  it("accepts a valid verdict", () => {
    expect(Verdict.safeParse(verdict).success).toBe(true);
  });

  it.each([
    ["unknown verdict", { verdict: "likely" }],
    ["unknown evidence_type", { evidence_type: "guessed" }],
    ["unknown impact", { impact: "external" }],
    ["unknown effort", { effort: "huge" }],
    ["bad fix status", { fix_assessment: { status: "fine", notes: "" } }],
    ["fix_assessment without notes", { fix_assessment: { status: "ok" } }],
    ["unknown key", { score: 5 }],
  ])("rejects %s", (_, patch) => {
    expect(Verdict.safeParse({ ...verdict, ...patch }).success).toBe(false);
  });
});
