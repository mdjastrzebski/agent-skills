import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the module `name` is the script node was started with. Compares real paths (the skill is often
 * installed through a symlink) and the file's stem: bundling inlines other CLI modules into one file, where they
 * share `import.meta.url` but must not run their own `main`.
 */
export function isEntry(moduleUrl: string, name: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  const self = fileURLToPath(moduleUrl);
  return basename(self).replace(/\.[^.]+$/, "") === name && realpathSync(script) === realpathSync(self);
}
