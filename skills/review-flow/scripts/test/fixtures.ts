export const finding = {
  id: "correctness-1",
  lens: "correctness",
  file: "src/cart.ts",
  line_start: 10,
  line_end: 12,
  category: "bug",
  severity: "high",
  title: "Total ignores discounts",
  claim: "applyDiscount result is discarded, so totals are too high.",
  evidence: "src/cart.ts:11 calls applyDiscount(total) without assigning it.",
  suggested_fix: "total = applyDiscount(total);",
};

export const candidate = { ...finding, id: "c-1", source_ids: ["correctness-1", "tests-2"] };

export const verdict = {
  candidate_id: "c-1",
  verdict: "confirmed",
  evidence_type: "executed",
  evidence: "Wrote test cart.discount.test.ts; it fails with 110 !== 100.",
  severity_reassessed: "high",
  impact: "user-facing",
  fix_assessment: { status: "ok", notes: "Test passes with the fix." },
  effort: "trivial",
};
