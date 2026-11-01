import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSpecs, matchTests, resolveImports } from "../src/context.js";
import { parseDiff, unquotePath } from "../src/diff.js";
import { prepare, PrepareError } from "../src/prepare.js";
import { resolveRunDir, RunDirError } from "../src/run-dir.js";
import { NO_USER_CONFIG, repo, sh, snapshot, write } from "./repo.js";

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
    const { runDir, context } = run(root, { preset: "standard" });
    expect(JSON.parse(readFileSync(join(runDir, "context.json"), "utf8"))).toEqual(context);
    expect(context.preset).toBe("standard");
    expect(context.limits).toEqual({ maxVerified: 25, parallel: 4, allowExecution: true });
    expect(context.lenses.map((l) => l.name)).toEqual(["correctness", "security", "tests", "performance"]);
    expect(context.specs).toEqual([]);
    expect(context.lenses[0].output).toBe("findings/correctness.json");
    expect(existsSync(context.lenses[0].prompt)).toBe(true);
    expect(context.models).toEqual({
      reviewer: { model: "opus", effort: "medium" },
      merger: { model: "haiku", effort: null },
      verifier: { model: "opus", effort: "medium" },
    });
    expect(context.stack).toMatchObject({ typescript: true, testRunner: "vitest" });
    expect(context.checks).toEqual({ typecheck: "npx tsc --noEmit", test: "npx vitest related --run" });
    expect(existsSync(join(runDir, "findings"))).toBe(true);
    const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace).toMatchObject([{ step: "prepare", status: "ok", harness: "claude", preset: "standard" }]);
    expect(trace[0].models).toEqual(context.models);
    expect(context.config_files).toEqual([]);
  });

  it("records the config files that were applied", () => {
    const root = repo();
    write(root, "review-flow.config.json", '{ "preset": "deep" }\n');
    const user = join(mkdtempSync(join(tmpdir(), "review-flow-user-")), "config.json");
    write(user, "", '{ "ignore": [] }\n');
    expect(run(root, { userConfigPath: user }).context.config_files).toEqual([
      { source: "user", path: user },
      { source: "repo", path: join(root, "review-flow.config.json") },
    ]);
  });

  it("applies --model and --effort to the effective preset and harness", () => {
    const root = repo();
    // The repo config picks the preset, so the overrides must land in `deep`, not the default `standard`.
    write(root, "review-flow.config.json", '{ "preset": "deep" }\n');
    const { context } = run(root, { models: ["verifier=sonnet"], efforts: ["verifier=max", "reviewer=default"] });
    expect(context.preset).toBe("deep");
    expect(context.models).toEqual({
      reviewer: { model: "opus", effort: null },
      merger: { model: "haiku", effort: null },
      verifier: { model: "sonnet", effort: "max" },
    });
    const cursor = run(root, { harness: "cursor", models: ["reviewer=claude-opus-5"], efforts: ["reviewer=high"] });
    expect(cursor.context.models.reviewer).toEqual({ model: "claude-opus-5[effort=high]", effort: null });
    expect(() => run(root, { models: ["judge=opus"] })).toThrow(/--model judge=opus: expected/);
    expect(() => run(root, { models: ["verifier"] })).toThrow(/expected/);
    expect(() => run(root, { efforts: ["verifier=extreme"] })).toThrow(
      /presets\.deep\.models\.claude\.verifier\.effort/,
    );
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

  it("adds the second correctness pass in the deep preset, right after correctness, and records the weights", () => {
    const root = repo();
    const deep = run(root, { preset: "deep" }).context;
    expect(deep.lenses.map((l) => l.name)).toEqual([
      "correctness",
      "correctness-alt",
      "security",
      "tests",
      "performance",
    ]);
    expect(existsSync(deep.lenses[1].prompt)).toBe(true);
    expect(deep.limits).toEqual({ maxVerified: 50, parallel: 6, allowExecution: true });
    expect(deep.models.reviewer).toEqual({ model: "opus", effort: "high" });
    expect(deep.models.verifier).toEqual({ model: "opus", effort: "high" });
    expect(deep.scoring.fixBeforeMergeThreshold).toBe(5);
    expect(run(root, { preset: "deep", lenses: ["correctness"] }).context.lenses.map((l) => l.name)).toEqual([
      "correctness",
      "correctness-alt",
    ]);
    expect(run(root, { preset: "deep", lenses: ["tests"] }).context.lenses.map((l) => l.name)).toEqual(["tests"]);
    expect(run(root, { lenses: ["correctness-alt"] }).context.lenses.map((l) => l.name)).toEqual(["correctness-alt"]);
    expect(run(root, { sets: ["scoring.fixBeforeMergeThreshold=3"] }).context.scoring.fixBeforeMergeThreshold).toBe(3);
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

  it("passes revision expressions through instead of prefixing origin/", () => {
    const root = repo();
    // origin/main has a parent, so `origin/HEAD~1` resolves too and must not be picked for `HEAD~1`.
    sh(root, "update-ref", "refs/remotes/origin/main", sh(root, "rev-parse", "feature").trim());
    sh(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(run(root, { base: "HEAD~1" }).context.target.base_ref).toBe("HEAD~1");
    expect(run(root, { base: "main~0" }).context.target.base_ref).toBe("main~0");
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

  it("picks models for the harness, folds effort into Cursor model ids, and rejects unknown harnesses", () => {
    const root = repo();
    expect(run(root, { harness: "cursor" }).context).toMatchObject({
      harness: "cursor",
      models: {
        reviewer: { model: "auto", effort: null },
        merger: { model: "auto", effort: null },
        verifier: { model: "auto", effort: null },
      },
    });
    const cursor = "presets.standard.models.cursor.verifier";
    const sets = [`${cursor}.model=claude-opus-5`, `${cursor}.effort=high`];
    expect(run(root, { harness: "cursor", sets }).context.models.verifier).toEqual({
      model: "claude-opus-5[effort=high]",
      effort: null,
    });
    const both = [`${cursor}.model=claude-opus-5[effort=low]`, `${cursor}.effort=high`];
    expect(() => run(root, { harness: "cursor", sets: both })).toThrow(/not both/);
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
    const result = spawnSync(process.execPath, [cli, "--preset", "deep"], { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    // Bundled-in CLI modules (config.ts) must not run their own main.
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines.at(-1)).toMatch(new RegExp(`^${root}/\\.review-flow/runs/current-\\d{8}-\\d{6}$`));
    const context = JSON.parse(readFileSync(join(lines.at(-1)!, "context.json"), "utf8"));
    expect(context.preset).toBe("deep");
    expect(context.lenses.map((lens: { name: string }) => lens.name)).toContain("correctness-alt");
    expect(lines.slice(-3, -1)).toEqual([
      "preset: deep · reviewer: opus/high · verifier: opus/high · lenses: 5",
      "config: built-in defaults only (no review-flow.config.json; config.mjs init creates one)",
    ]);
  });

  it("takes repeated --model / --effort flags and names applied config files", () => {
    const root = repo();
    write(root, "review-flow.config.json", "{}\n");
    const env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "review-flow-xdg-")) };
    const args = [cli, "--model", "verifier=sonnet", "--effort=verifier=default", "--model", "reviewer=haiku"];
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.slice(-3, -1)).toEqual([
      "preset: standard · reviewer: haiku/medium · verifier: sonnet · lenses: 4",
      `config: repo ${join(root, "review-flow.config.json")}`,
    ]);
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
