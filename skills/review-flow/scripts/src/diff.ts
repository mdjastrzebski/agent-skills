export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** One changed file in a unified diff; `hunks` are new-side line ranges (1-based, inclusive). */
export type DiffFile = {
  path: string;
  old_path?: string;
  status: FileStatus;
  binary: boolean;
  hunks: { start: number; end: number }[];
};

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  '"': '"',
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  r: "\r",
  v: "\v",
};

/** Undoes git's C-style quoting of unusual paths (`"a\"b"`, octal bytes for non-ASCII). */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(...Buffer.from(ESCAPES[next] ?? next));
  }
  return Buffer.from(bytes).toString("utf8");
}

function headerPath(line: string, prefix: string): string | null {
  // git appends a tab after paths that contain spaces.
  const raw = unquotePath(line.replace(/\t$/, ""));
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  // Hunk bodies can contain lines like "--- x" (a removed "-- x"), so headers are only read before the first hunk.
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Fallback for header-only diffs (mode changes, binaries): `diff --git a/x b/x` with equal halves.
      const rest = line.slice("diff --git ".length);
      const half = rest.length >> 1;
      const guess = rest.startsWith("a/") && rest.slice(half + 1).startsWith("b/") ? rest.slice(half + 3) : undefined;
      current = { path: guess ?? "", status: "modified", binary: false, hunks: [] };
      files.push(current);
      inHeader = true;
    } else if (!current) continue;
    else if (line.startsWith("@@ ")) {
      inHeader = false;
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      // A pure deletion has count 0; anchor it at the line after which it happened.
      current.hunks.push({ start: Math.max(start, 1), end: Math.max(start + count - 1, start, 1) });
    } else if (!inHeader) continue;
    else if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.old_path = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) current.path = unquotePath(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ")) current.binary = true;
    else if (line.startsWith("--- ")) {
      const path = headerPath(line.slice(4), "a/");
      if (path && current.status === "deleted") current.path = path;
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4), "b/");
      if (path) current.path = path;
    }
  }
  return files.filter((file) => file.path !== "");
}
