import { formatIssue } from "./issues.js";
import { KINDS, type Kind } from "./schemas.js";

export type ValidationResult = { ok: true; data: unknown } | { ok: false; errors: string[] };

export function validateValue(kind: Kind, input: unknown): ValidationResult {
  const result = KINDS[kind].schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues.map((issue) => formatIssue(issue, input)) };
}

export function validateText(kind: Kind, text: string): ValidationResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root): invalid JSON: ${(error as Error).message}`] };
  }
  return validateValue(kind, input);
}
