/**
 * Validate a run-directory JSON file against its schema.
 *
 * Usage: node scripts/dist/validate.mjs <findings|candidates|verdict> <file>
 *
 * Exit 0 when valid (prints "ok: <file>"), 1 when invalid (one "path: message" line per issue on stderr),
 * 2 on usage or read errors.
 */
import { readFileSync } from "node:fs";
import { isEntry } from "./cli.js";
import { KINDS, type Kind } from "./schemas.js";
import { validateText } from "./validation.js";

export { validateText, validateValue, type ValidationResult } from "./validation.js";

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

if (isEntry(import.meta.url, "validate")) {
  process.exitCode = main(process.argv.slice(2));
}
