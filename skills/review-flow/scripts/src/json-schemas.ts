import { z } from "zod";
import { KINDS } from "./schemas.js";

/** JSON Schemas for prompts and editors, keyed by file name under `schemas/`. */
export function jsonSchemas(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { jsonSchemaName, item } of Object.values(KINDS)) {
    files[`${jsonSchemaName}.schema.json`] = JSON.stringify(z.toJSONSchema(item, { io: "input" }), null, 2) + "\n";
  }
  return files;
}
