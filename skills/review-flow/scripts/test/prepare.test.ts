import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSpecs, matchTests, resolveImports } from "../src/context.js";
import { parseDiff, unquotePath } from "../src/diff.js";
import { prepare, PrepareError } from "../src/prepare.js";
import { resolveRunDir, RunDirError } from "../src/run-dir.js";

const NO_USER_CONFIG = join(tmpdir(), "review-flow-no-user-config.json");

function sh(cwd: string, ...args: string[]): string {
  // GIT_OPTIONAL_LOCKS=0: the snapshot's own `git status` must not refresh the index it is hashing.
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repo on `main` with one commit, then a `feature` branch with a commit and every kind of uncommitted change. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-flow-prepare-")));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "Test");
  write(root, "package.json", JSON.stringify({ devDependencies: { typescript: "5", vitest: "3" } }));
  write(root, "src/cart.ts", 'import { tax } from "./tax.js";\nexport const total = (n: number) => n + tax(n);\n');
  write(root, "src/tax.ts", "export const tax = (n: number) => n * 0.2;\n");
  write(root, "src/old.ts", "export {};\n");
  write(root, "test/cart.test.ts", "// tests\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "init");
  sh(root, "checkout", "-q", "-b", "feature");
  write(root, "src/committed.ts", "export const committed = 1;\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "feature work");
  write(root, "src/tax.ts", "export const tax = (n: number) => n * 0.25;\n"); // staged
  sh(root, "add", "src/tax.ts");
  write(root, "src/cart.ts", 'import { tax } from "./tax.js";\nexport const total = (n: number) => n + tax(n) + 1;\n'); // unstaged
  sh(root, "rm", "-q", "src/old.ts");
  write(root, "src/new file.ts", "export const fresh = true;\n"); // untracked, with a space
  return root;
}

/** Everything §11.3 says must be byte-identical: working tree status, index, branch, stash. */
function snapshot(root: string) {
  return {
    status: sh(root, "status", "--porcelain=v2", "--untracked-files=all"),
    index: createHash("sha256")
      .update(readFileSync(join(root, ".git/index")))
      .digest("hex"),
    branch: sh(root, "symbolic-ref", "HEAD"),
    head: sh(root, "rev-parse", "HEAD"),
    stash: sh(root, "stash", "list"),
    worktrees: sh(root, "worktree", "list", "--porcelain"),
  };
}

const run = (root: string, options: Partial<Parameters<typeof prepare>[0]> = {}) =>
  prepare({ repoRoot: root, userConfigPath: NO_USER_CONFIG, now: new Date("2026-11-01T12:34:56Z"), ...options });

describe("prepare (current mode)", () => {
  it("includes committed, staged, unstaged, deleted and untracked changes", () => {
    const root = repo();
    const { runDir, context } = run(root);
    expect(runDir).toBe(join(root, ".review-flow/runs/current-20261101-123456"));
    expect(context.files.map((f) => [f.path, f.status])).toEqual([
      ["src/cart.ts", "modified"],
      ["src/committed.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/tax.ts", "modified"],
      ["src/new file.ts", "added"],
    ]);
    const patch = readFileSync(join(runDir, "diff.patch"), "utf8");
    expect(patch).toContain("+export const total = (n: number) => n + tax(n) + 1;");
    expect(patch).toContain("+export const fresh = true;");
    expect(context.target).toMatchObject({
      mode: "current",
      branch: "feature",
      base: "main",
      base_ref: "main",
      dirty: true,
    });
    expect(context.target.merge_base).toBe(sh(root, "rev-parse", "main").trim());
    expect(context.code_root).toBe(root);
  });

  it("collects per-file context: hunks, size, imports, tests", () => {
    const { context } = run(repo());
    const cart = context.files.find((f) => f.path === "src/cart.ts")!;
    expect(cart).toMatchObject({
      hunks: [{ start: 1, end: 2 }],
      lines: 2,
      truncated: false,
      imports: ["src/tax.ts"],
      tests: ["test/cart.test.ts"],
    });
    expect(context.files.find((f) => f.path === "src/old.ts")).toMatchObject({ lines: null, imports: [], tests: [] });
  });

  it("writes context.json with stack, checks, lenses, limits and models from the config", () => {
    const root = repo();
    const { runDir, context } = run(root, { rigor: "low" });
    expect(JSON.parse(readFileSync(join(runDir, "context.json"), "utf8"))).toEqual(context);
    expect(context.rigor).toBe("low");
    expect(context.limits).toEqual({ maxVerified: 10, parallel: 3, allowExecution: false });
    expect(context.lenses.map((l) => l.name)).toEqual(["correctness", "security"]);
    expect(context.specs).toEqual([]);
    expect(context.lenses[0].output).toBe("findings/correctness.json");
    expect(existsSync(context.lenses[0].prompt)).toBe(true);
    expect(context.models).toEqual({ reviewer: "sonnet", merger: "haiku", verifier: "opus" });
    expect(context.stack).toMatchObject({ typescript: true, testRunner: "vitest" });
    expect(context.checks).toEqual({ typecheck: "npx tsc --noEmit", test: "npx vitest related --run" });
    expect(existsSync(join(runDir, "findings"))).toBe(true);
    const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace).toMatchObject([{ step: "prepare", status: "ok", harness: "claude" }]);
  });

  it("runs the spec lens only when spec documents exist, and honors --lenses", () => {
    const root = repo();
    expect(run(root).context).toMatchObject({ specs: [] });
    expect(run(root).context.lenses.map((l) => l.name)).toEqual(["correctness", "security", "tests", "performance"]);
    write(root, "src/SPEC.md", "# Cart spec\n");
    const { context } = run(root);
    expect(context.specs).toEqual(["src/SPEC.md"]);
    expect(context.lenses.map((l) => l.name)).toContain("spec");
    expect(() => run(root, { sets: ["specs=docs/none.md"] })).toThrow(/specs not found/);
  });

  it("honors --lenses", () => {
    const root = repo();
    expect(run(root, { lenses: ["tests", "spec"] }).context.lenses.map((l) => l.name)).toEqual(["tests", "spec"]);
    expect(() => run(root, { lenses: ["style"] })).toThrow(/unknown lens/);
  });

  it("prefers origin/<base> for a bare base name and passes other refs through", () => {
    const root = repo();
    const initial = sh(root, "rev-parse", "main").trim();
    // Local main moves ahead; origin/main stays at the initial commit.
    sh(root, "update-ref", "refs/remotes/origin/main", initial);
    sh(root, "update-ref", "refs/heads/main", sh(root, "rev-parse", "feature").trim());
    expect(run(root, { base: "main" }).context.target).toMatchObject({ base_ref: "origin/main", merge_base: initial });
    expect(run(root, { base: "origin/main" }).context.target.base_ref).toBe("origin/main");
  });

  it("resolves custom lenses and the lenses.enabled filter", () => {
    const root = repo();
    const custom = run(root, {
      sets: ['lenses.custom=["prompts/style.md"]', 'lenses.enabled=["correctness"]'],
    }).context;
    expect(custom.lenses).toEqual([
      expect.objectContaining({ name: "correctness" }),
      { name: "style", prompt: join(root, "prompts/style.md"), output: "findings/style.json" },
    ]);
    const only = run(root, { sets: ['lenses.custom=["prompts/style.md"]'], lenses: ["style"] }).context;
    expect(only.lenses.map((l) => l.name)).toEqual(["style"]);
  });

  it("picks models for the harness and rejects unknown harnesses", () => {
    const root = repo();
    expect(run(root, { harness: "cursor" }).context).toMatchObject({
      harness: "cursor",
      models: { reviewer: "auto", merger: "auto", verifier: "auto" },
    });
    expect(() => run(root, { harness: "vim" })).toThrow(/unknown harness/);
  });

  it("skips deleted files and symlinks when collecting context", () => {
    const root = repo();
    write(root, "src/SPEC.md", "# spec\n");
    sh(root, "add", "src/SPEC.md");
    sh(root, "commit", "-q", "-m", "spec");
    rmSync(join(root, "src/SPEC.md"));
    symlinkSync("/etc/hosts", join(root, "src/link.ts"));
    const { context } = run(root);
    expect(context.specs).toEqual([]);
    expect(context.files.find((f) => f.path === "src/link.ts")).toMatchObject({ lines: null, imports: [] });
  });

  it("applies config ignore globs and --base HEAD (uncommitted only)", () => {
    const root = repo();
    const { context } = run(root, { base: "HEAD", sets: ['ignore=["src/new file.ts","**/tax.ts"]'] });
    expect(context.files.map((f) => f.path)).toEqual(["src/cart.ts", "src/old.ts"]);
  });

  it("leaves the working tree, index, branch, stash and worktrees byte-identical", () => {
    const root = repo();
    // Make the index stat info stale, so any opportunistic refresh would rewrite it.
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(root, "test/cart.test.ts"), past, past);
    const before = snapshot(root);
    run(root);
    expect(snapshot(root)).toEqual(before);
  });

  it("adds .review-flow/ to .git/info/exclude exactly once", () => {
    const root = repo();
    run(root);
    run(root);
    const exclude = readFileSync(join(root, ".git/info/exclude"), "utf8");
    expect(exclude.match(/^\.review-flow\/$/gm)).toHaveLength(1);
    // The run directory itself never shows up as a change in the next run.
    expect(run(root).context.files.every((f) => !f.path.startsWith(".review-flow"))).toBe(true);
  });

  it("does not reuse a run directory created in the same second", () => {
    const root = repo();
    expect(run(root).runDir).not.toBe(run(root).runDir);
  });

  it("fails clearly on unsupported targets and empty diffs", () => {
    const root = repo();
    expect(() => run(root, { target: "pr:12" })).toThrow(PrepareError);
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "all");
    expect(() => run(root, { base: "HEAD" })).toThrow(/nothing to review/);
    expect(() => run(root, { base: "nope" })).toThrow(/not a commit/);
  });
});

describe("run directory guard", () => {
  it("accepts run dirs and refuses anything else", () => {
    const root = repo();
    const { runDir } = run(root);
    expect(resolveRunDir(runDir)).toEqual({ runDir, repoRoot: root });
    expect(() => resolveRunDir(root)).toThrow(RunDirError);
    expect(() => resolveRunDir(join(root, ".review-flow/runs"))).toThrow(RunDirError);
    expect(() => resolveRunDir(join(root, "src"))).toThrow(RunDirError);
    expect(() => resolveRunDir(join(root, "missing"))).toThrow(/not found/);
  });
});

describe("parseDiff", () => {
  it("reads statuses, renames, binaries and new-side hunk ranges", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      "--- not a header",
      "+++ not a header either",
      "@@ -10,2 +11,0 @@",
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
    ].join("\n");
    expect(parseDiff(patch)).toEqual([
      {
        path: "a.ts",
        status: "modified",
        binary: false,
        hunks: [
          { start: 1, end: 4 },
          { start: 11, end: 11 },
        ],
      },
      { path: "new.ts", old_path: "old.ts", status: "renamed", binary: false, hunks: [] },
      { path: "img.png", status: "modified", binary: true, hunks: [] },
      { path: "gone.ts", status: "deleted", binary: false, hunks: [{ start: 1, end: 1 }] },
    ]);
  });

  it("unquotes C-style paths", () => {
    expect(unquotePath('"a\\"b\\tc"')).toBe('a"b\tc');
    expect(unquotePath('"caf\\303\\251.ts"')).toBe("café.ts");
    expect(unquotePath("plain.ts")).toBe("plain.ts");
  });
});

describe("detectSpecs", () => {
  it("keeps spec-named markdown in directories of changed files, nearest first", () => {
    const all = [
      "SPEC.md",
      "a/SPEC.md",
      "a/b/feature.spec.md",
      "a/specs/api.md",
      "other/PRD.md",
      "a/b/notes.md",
      "a/b/x.spec.ts",
    ];
    expect(detectSpecs(["a/b/x.ts"], all)).toEqual(["a/b/feature.spec.md", "a/specs/api.md", "a/SPEC.md", "SPEC.md"]);
    expect(detectSpecs(["README.md"], all)).toEqual(["SPEC.md"]);
  });
});

describe("file context helpers", () => {
  it("resolves relative imports, including NodeNext .js specifiers and index files", () => {
    const root = mkdtempSync(join(tmpdir(), "review-flow-imports-"));
    for (const file of ["src/a.ts", "src/b.tsx", "src/lib/index.ts", "src/c.mjs"]) write(root, file, "");
    const source = [
      'import { b } from "./b.js";',
      'export * from "./lib";',
      'const c = await import("./c.mjs");',
      'import "./missing.js";',
      'import React from "react";',
      'const self = require("./a");',
    ].join("\n");
    expect(resolveImports(root, "src/a.ts", source)).toEqual(["src/b.tsx", "src/c.mjs", "src/lib/index.ts"]);
    expect(resolveImports(root, "README.md", source)).toEqual([]);
  });

  it("matches test files by stem, nearby first", () => {
    const files = ["z/cart.test.ts", "src/cart.spec.tsx", "src/__tests__/cart.ts", "src/cartography.test.ts"];
    expect(matchTests("src/cart.ts", files)).toEqual(["src/__tests__/cart.ts", "src/cart.spec.tsx", "z/cart.test.ts"]);
    expect(matchTests("src/cart.test.ts", files)).toEqual([]);
  });
});

describe("dist/prepare.mjs CLI", () => {
  const cli = join(import.meta.dirname, "../dist/prepare.mjs");

  it("prints the run directory as the last line", () => {
    const root = repo();
    const env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "review-flow-xdg-")) };
    const result = spawnSync(process.execPath, [cli, "--rigor", "low"], { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    // Bundled-in CLI modules (config.ts) must not run their own main.
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines.at(-1)).toMatch(new RegExp(`^${root}/\\.review-flow/runs/current-\\d{8}-\\d{6}$`));
    expect(existsSync(join(lines.at(-1)!, "context.json"))).toBe(true);
  });

  it("exits 1 with a message on errors and 2 on usage errors", () => {
    const root = repo();
    const env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "review-flow-xdg-")) };
    const unsupported = spawnSync(process.execPath, [cli, "--target", "pr:1"], { cwd: root, env, encoding: "utf8" });
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toMatch(/not supported yet/);
    expect(spawnSync(process.execPath, [cli, "--bogus"], { cwd: root, env }).status).toBe(2);
    expect(spawnSync(process.execPath, [cli, "--base="], { cwd: root, env }).status).toBe(2);
  });
});
