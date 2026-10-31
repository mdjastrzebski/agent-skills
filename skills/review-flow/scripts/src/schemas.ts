import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = ["bug", "security", "performance", "test-gap", "maintainability", "platform"] as const;

const Severity = z.enum(SEVERITIES);
const LineNumber = z.number().int().min(1);

const findingFields = {
  id: z.string().min(1),
  lens: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lens must be kebab-case, e.g. \"react-native\""),
  file: z.string().min(1),
  line_start: LineNumber,
  line_end: LineNumber,
  category: z.enum(CATEGORIES),
  severity: Severity,
  title: z.string().min(1).max(80),
  claim: z.string().min(1),
  evidence: z.string().min(1),
  suggested_fix: z.string().min(1).optional(),
};

type LineRange = { line_start: number; line_end: number };

function checkLineRange(value: LineRange, ctx: z.RefinementCtx) {
  if (value.line_end < value.line_start) {
    ctx.addIssue({
      code: "custom",
      path: ["line_end"],
      message: `line_end (${value.line_end}) must be >= line_start (${value.line_start})`,
    });
  }
}

export const Finding = z
  .strictObject(findingFields)
  .superRefine((value, ctx) => {
    checkLineRange(value, ctx);
    if (!new RegExp(`^${value.lens}-\\d+$`).test(value.id)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `id must be "<lens>-<n>", e.g. "${value.lens}-1"` });
    }
  });

export const Candidate = z
  .strictObject({ ...findingFields, source_ids: z.array(z.string().min(1)).min(1) })
  .superRefine(checkLineRange);

export const Verdict = z.strictObject({
  candidate_id: z.string().min(1),
  verdict: z.enum(["confirmed", "refuted", "uncertain"]),
  evidence_type: z.enum(["executed", "traced", "reasoned"]),
  evidence: z.string().min(1),
  severity_reassessed: Severity,
  impact: z.enum(["user-facing", "developer-facing", "internal"]),
  fix_assessment: z.strictObject({
    status: z.enum(["ok", "incomplete", "wrong", "absent"]),
    notes: z.string(),
  }),
  effort: z.enum(["trivial", "small", "medium", "large"]),
});

function uniqueIds<T extends { id: string }>(items: T[], ctx: z.RefinementCtx) {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const first = seen.get(item.id);
    if (first === undefined) seen.set(item.id, index);
    else ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate id "${item.id}" (first used at [${first}])` });
  });
}

export const FindingList = z.array(Finding).superRefine(uniqueIds);
export const CandidateList = z.array(Candidate).superRefine(uniqueIds);

export type Finding = z.infer<typeof Finding>;
export type Candidate = z.infer<typeof Candidate>;
export type Verdict = z.infer<typeof Verdict>;

/** Schemas accepted by `validate.mjs <kind>`, and exported as `schemas/<name>.schema.json`. */
export const KINDS = {
  findings: { schema: FindingList, jsonSchemaName: "finding", item: Finding },
  candidates: { schema: CandidateList, jsonSchemaName: "candidate", item: Candidate },
  verdict: { schema: Verdict, jsonSchemaName: "verdict", item: Verdict },
} as const;

export type Kind = keyof typeof KINDS;
