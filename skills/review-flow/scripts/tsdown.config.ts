import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, type UserConfig } from "tsdown";
import { jsonSchemas } from "./src/json-schemas.js";

// CLI entries, each bundled into a self-contained dist/<name>.mjs (zod inlined).
const entries = ["validate"];

function writeJsonSchemas() {
  mkdirSync("../schemas", { recursive: true });
  for (const [name, content] of Object.entries(jsonSchemas())) writeFileSync(`../schemas/${name}`, content);
}

// One config per entry: a shared multi-entry build would split zod into hashed chunk files.
export default defineConfig(
  entries.map((name, index): UserConfig => ({
    entry: { [name]: `src/${name}.ts` },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node20",
    clean: false,
    deps: { onlyBundle: ["zod"] },
    dts: false,
    hooks: index === 0 ? { "build:done": writeJsonSchemas } : undefined,
  })),
);
