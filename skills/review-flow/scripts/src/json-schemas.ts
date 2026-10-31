import { z } from "zod";
import { ConfigFile } from "./config-schema.js";
import { KINDS } from "./schemas.js";

/** JSON Schemas for prompts and editors, keyed by file name under `schemas/`. */
export function jsonSchemas(): Record<string, string> {
  const files: Record<string, string> = {};
  const render = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2) + "\n";
  for (const { jsonSchemaName, item } of Object.values(KINDS)) files[`${jsonSchemaName}.schema.json`] = render(item);
  files["config.schema.json"] = render(ConfigFile);
  return files;
}
