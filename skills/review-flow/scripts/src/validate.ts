/**
 * Validate a run-directory JSON file against its schema.
 *
 * Usage: node scripts/dist/validate.mjs <findings|candidates|verdict> <file>
 *
 * Exit 0 when valid (prints "ok: <file>"), 1 when invalid (one "path: message" line per issue on stderr),
 * 2 on usage or read errors.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

export function main(argv: string[]): number {
  const [kind, file] = argv;
  if (!kind || !file || !(kind in KINDS)) {
    console.error(`usage: validate.mjs <${Object.keys(KINDS).join("|")}> <file>`);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`cannot read ${file}: ${(error as Error).message}`);
    return 2;
  }
  const result = validateText(kind as Kind, text);
  if (result.ok) {
    console.log(`ok: ${file}`);
    return 0;
  }
  console.error(`invalid ${kind}: ${file}`);
  for (const line of result.errors) console.error(`  ${line}`);
  return 1;
}

// Compare real paths: the skill is often installed through a symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
