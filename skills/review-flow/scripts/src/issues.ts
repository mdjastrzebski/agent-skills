import type { z } from "zod";

/** Readable `path: message` lines for zod issues, shared by every script that validates agent-written JSON. */
export function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : i === 0 ? String(part) : `.${String(part)}`))
    .join("");
}

export function formatIssue(issue: z.core.$ZodIssue, input: unknown): string {
  const where = formatPath(issue.path);
  switch (issue.code) {
    case "invalid_value":
      return `${where}: expected one of ${issue.values.map((v) => JSON.stringify(v)).join(" | ")}, got ${JSON.stringify(valueAt(input, issue.path))}`;
    case "unrecognized_keys":
      return `${where}: unknown key(s) ${issue.keys.map((k) => JSON.stringify(k)).join(", ")}`;
    case "invalid_type":
      return valueAt(input, issue.path) === undefined
        ? `${where}: required ${issue.expected} is missing`
        : `${where}: expected ${issue.expected}, got ${describe(valueAt(input, issue.path))}`;
    default:
      return `${where}: ${issue.message}`;
  }
}

function valueAt(input: unknown, path: PropertyKey[]): unknown {
  let current: any = input;
  for (const part of path) current = current?.[part as any];
  return current;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "string" ? `string ${JSON.stringify(value)}` : typeof value;
}
