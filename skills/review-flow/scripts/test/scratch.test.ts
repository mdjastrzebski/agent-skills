import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanup } from "../src/cleanup.js";
import { prepare } from "../src/prepare.js";
import { RunDirError } from "../src/run-dir.js";
import { createScratch, removeScratch, ScratchError } from "../src/worktree.js";
import { candidate } from "./fixtures.js";
import { NO_USER_CONFIG, repo, sh, snapshot, write } from "./repo.js";

/** A prepared `current` run over `repo()` (every kind of uncommitted change), with candidates c-1 and c-2. */
function setup(sets: string[] = []) {
  const root = repo();
  // Ignored dependencies at the root and in a nested package, plus a binary file with an uncommitted change.
  write(root, ".gitignore", "node_modules/\n");
  write(root, "img.bin", "\0\x01\x02 before");
  sh(root, "add", ".gitignore", "img.bin");
  sh(root, "commit", "-q", "-m", "ignore deps");
  write(root, "img.bin", "\0\x01\x02 after");
  write(root, "node_modules/dep/index.js", "module.exports = 1;\n");
  write(root, "pkg/node_modules/inner/index.js", "module.exports = 2;\n");
  const { runDir } = prepare({ repoRoot: root, userConfigPath: NO_USER_CONFIG, sets });
  mkdirSync(join(runDir, "candidates"));
  for (const id of ["c-1", "c-2"])
    writeFileSync(join(runDir, "candidates", `${id}.json`), JSON.stringify({ ...candidate, id }));
  return { root, runDir };
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

describe("scratch worktrees (current mode)", () => {
  it("reproduces HEAD plus staged, unstaged, deleted, binary and untracked changes", () => {
    const { root, runDir } = setup();
    const scratch = createScratch(runDir, "c-1");
    expect(scratch.path).toBe(join(runDir, "scratch/c-1"));
    expect(sh(scratch.path, "rev-parse", "HEAD")).toBe(sh(root, "rev-parse", "HEAD"));
    for (const file of ["src/tax.ts", "src/cart.ts", "src/new file.ts", "src/committed.ts", "img.bin"])
      expect(read(scratch.path, file)).toBe(read(root, file));
    expect(existsSync(join(scratch.path, "src/old.ts"))).toBe(false);
    // The run directory (and so the scratch worktree itself) is never copied in.
    expect(existsSync(join(scratch.path, ".review-flow"))).toBe(false);
    expect(scratch.copied).toBe(1);
  });

  it("mirrors ignored node_modules as per-package symlinks instead of installing", () => {
    const { root, runDir } = setup();
    write(root, "node_modules/@scope/a/index.js", "module.exports = 3;\n");
    write(root, "node_modules/.vite/vitest/results.json", "{}");
    write(root, "packages/lib/index.js", "module.exports = 'user';\n");
    symlinkSync("../../packages/lib", join(root, "node_modules/@scope/lib")); // a workspace package
    mkdirSync(join(root, "node_modules/.bin"));
    symlinkSync("../dep/index.js", join(root, "node_modules/.bin/dep"));
    const scratch = createScratch(runDir, "c-1");
    expect(scratch.nodeModules).toEqual(["node_modules", "pkg/node_modules"]);
    const at = (path: string) => join(scratch.path, path);
    // Real directories, so tool caches written into node_modules land in scratch; the user's cache is left out.
    for (const dir of ["node_modules", "node_modules/@scope", "pkg/node_modules"])
      expect(lstatSync(at(dir)).isDirectory()).toBe(true);
    expect(existsSync(at("node_modules/.vite"))).toBe(false);
    expect(readlinkSync(at("node_modules/dep"))).toBe(join(root, "node_modules/dep"));
    expect(readlinkSync(at("node_modules/@scope/a"))).toBe(join(root, "node_modules/@scope/a"));
    expect(readlinkSync(at("pkg/node_modules/inner"))).toBe(join(root, "pkg/node_modules/inner"));
    // Links into the repo resolve inside scratch: a fix applied to the workspace package there is what runs.
    expect(readlinkSync(at("node_modules/@scope/lib"))).toBe(at("packages/lib"));
    write(scratch.path, "packages/lib/index.js", "module.exports = 'scratch';\n");
    expect(read(scratch.path, "node_modules/@scope/lib/index.js")).toBe("module.exports = 'scratch';\n");
    expect(read(scratch.path, "node_modules/.bin/dep")).toBe(read(root, "node_modules/dep/index.js"));
    write(scratch.path, "node_modules/.vite/vitest/results.json", '{"scratch":true}');
    expect(read(root, "node_modules/.vite/vitest/results.json")).toBe("{}");
  });

  it("applies the changes whatever the user's diff.context", () => {
    const { root, runDir } = setup();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    write(root, "src/long.ts", `${lines.join("\n")}\n`);
    sh(root, "add", "src/long.ts");
    sh(root, "commit", "-q", "-m", "long file");
    const head = sh(root, "rev-parse", "HEAD").trim();
    const context = JSON.parse(read(runDir, "context.json"));
    writeFileSync(
      join(runDir, "context.json"),
      JSON.stringify({ ...context, target: { ...context.target, head_sha: head } }),
    );
    // Mid-file edits: zero-context hunks there are what `git apply` refuses.
    write(root, "src/long.ts", `${lines.map((line, i) => (i % 5 === 2 ? `${line} edited` : line)).join("\n")}\n`);
    sh(root, "config", "diff.context", "0");
    const scratch = createScratch(runDir, "c-1");
    expect(read(scratch.path, "src/long.ts")).toBe(read(root, "src/long.ts"));
  });

  it("keeps file modes and recreates untracked symlinks", () => {
    const { root, runDir } = setup();
    write(root, "bin/run.sh", "#!/bin/sh\n");
    chmodSync(join(root, "bin/run.sh"), 0o755);
    symlinkSync("run.sh", join(root, "bin/link.sh"));
    const scratch = createScratch(runDir, "c-1");
    expect(lstatSync(join(scratch.path, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(scratch.path, "bin/link.sh"))).toBe("run.sh");
  });

  it("starts from the prepared HEAD even after the user commits", () => {
    const { root, runDir } = setup();
    const prepared = sh(root, "rev-parse", "HEAD");
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "user commits mid-run");
    const scratch = createScratch(runDir, "c-1");
    expect(sh(scratch.path, "rev-parse", "HEAD")).toBe(prepared);
    expect(read(scratch.path, "src/cart.ts")).toBe(read(root, "src/cart.ts"));
    expect(existsSync(join(scratch.path, "src/old.ts"))).toBe(false);
  });

  it("replaces an existing scratch worktree and removes it with whatever the verifier wrote", () => {
    const { runDir } = setup();
    const first = createScratch(runDir, "c-1");
    write(first.path, "repro.test.ts", "// repro\n");
    write(first.path, "src/cart.ts", "// edited by the verifier\n");
    const second = createScratch(runDir, "c-1");
    expect(existsSync(join(second.path, "repro.test.ts"))).toBe(false);
    write(second.path, "repro.test.ts", "// repro\n");
    expect(removeScratch(runDir, "c-1")).toBe(true);
    expect(existsSync(second.path)).toBe(false);
    expect(removeScratch(runDir, "c-1")).toBe(false);
  });

  it("leaves the user's working tree, index, branch, stash and worktree list byte-identical", () => {
    const { root, runDir } = setup();
    // Make the index stat info stale, so any opportunistic refresh would rewrite it.
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(root, "test/cart.test.ts"), past, past);
    const before = snapshot(root);
    const scratch = createScratch(runDir, "c-1");
    createScratch(runDir, "c-2");
    write(scratch.path, "src/cart.ts", "// a verifier's repro edit\n");
    const { worktrees: _, ...during } = snapshot(root);
    const { worktrees: __, ...beforeWithoutWorktrees } = before;
    expect(during).toEqual(beforeWithoutWorktrees);
    removeScratch(runDir, "c-1");
    // cleanup takes away whatever a verifier forgot to remove.
    expect(cleanup(runDir)).toEqual([join(runDir, "scratch/c-2")]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(runDir, "context.json"))).toBe(true);
    expect(cleanup(runDir)).toEqual([]);
  });

  it("re-creates a scratch worktree whose directory was deleted while it stayed registered", () => {
    const { runDir } = setup();
    const scratch = createScratch(runDir, "c-1");
    rmSync(scratch.path, { recursive: true, force: true });
    expect(createScratch(runDir, "c-1").path).toBe(scratch.path);
    expect(existsSync(join(scratch.path, "src/cart.ts"))).toBe(true);
  });

  it("removes a broken scratch worktree or a stray directory without touching other worktrees", () => {
    const { root, runDir } = setup();
    // A user worktree whose directory moved away: prunable, but only the user may prune it.
    const userWorktree = join(root, "..", `${basename(root)}-user-wt`);
    sh(root, "worktree", "add", "-q", "--detach", userWorktree);
    renameSync(userWorktree, `${userWorktree}-moved`);
    const before = snapshot(root);
    const scratch = createScratch(runDir, "c-1");
    rmSync(join(scratch.path, ".git")); // a verifier broke it
    expect(removeScratch(runDir, "c-1")).toBe(true);
    expect(existsSync(scratch.path)).toBe(false);
    write(scratch.path, "stray.txt", "not a worktree\n");
    expect(createScratch(runDir, "c-1").path).toBe(scratch.path);
    cleanup(runDir);
    expect(snapshot(root)).toEqual(before);
    expect(sh(root, "worktree", "list", "--porcelain")).toContain(userWorktree);
  });

  it("cleans up and reports a scratch worktree that can't be built", () => {
    const { root, runDir } = setup();
    const before = snapshot(root);
    const context = JSON.parse(read(runDir, "context.json"));
    writeFileSync(
      join(runDir, "context.json"),
      JSON.stringify({ ...context, target: { ...context.target, head_sha: "0".repeat(40) } }),
    );
    expect(() => createScratch(runDir, "c-1")).toThrow(/cannot create the scratch worktree/);
    expect(existsSync(join(runDir, "scratch/c-1"))).toBe(false);
    expect(snapshot(root)).toEqual(before);
    const last = JSON.parse(read(runDir, "trace.jsonl").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ step: "scratch-create", status: "error", candidate_id: "c-1" });
  });

  it("never runs the user's git hooks", () => {
    const { root, runDir } = setup();
    write(root, ".git/hooks/post-checkout", `#!/bin/sh\ntouch "${join(root, "hook-ran")}"\n`);
    chmodSync(join(root, ".git/hooks/post-checkout"), 0o755);
    createScratch(runDir, "c-1");
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  it("refuses unknown or path-like ids and disabled execution", () => {
    const { runDir } = setup();
    expect(() => createScratch(runDir, "c-9")).toThrow(RunDirError);
    expect(() => createScratch(runDir, "../c-1")).toThrow(/invalid candidate id/);
    expect(() => removeScratch(runDir, "..")).toThrow(/invalid candidate id/);
    const disabled = setup(["presets.standard.allowExecution=false"]);
    expect(() => createScratch(disabled.runDir, "c-1")).toThrow(ScratchError);
    expect(existsSync(join(disabled.runDir, "scratch/c-1"))).toBe(false);
  });

  it("records create and remove in trace.jsonl", () => {
    const { runDir } = setup();
    createScratch(runDir, "c-1");
    removeScratch(runDir, "c-1");
    const steps = read(runDir, "trace.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(steps.map((s) => s.step)).toEqual(["prepare", "scratch-create", "scratch-remove"]);
    expect(steps[1]).toMatchObject({ status: "ok", candidate_id: "c-1", node_modules: 2 });
  });
});

describe("dist/scratch.mjs and dist/cleanup.mjs CLIs", () => {
  const cli = (name: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dirname, `../dist/${name}.mjs`), ...args], { encoding: "utf8" });

  it("creates (path on the last line), removes and cleans up, with usage errors as exit 2", () => {
    const { runDir } = setup();
    const created = cli("scratch", "create", runDir, "c-1");
    expect(created.status).toBe(0);
    expect(created.stdout.trim().split("\n").at(-1)).toBe(join(runDir, "scratch/c-1"));
    expect(created.stdout).toContain("node_modules packages linked");
    expect(cli("scratch", "remove", runDir, "c-1").stdout).toContain("removed");
    expect(cli("cleanup", runDir)).toMatchObject({ status: 0, stdout: "removed 0 worktree(s); run files kept\n" });
    expect(cli("scratch", "create", runDir).status).toBe(2);
    expect(cli("scratch", "create", runDir, "nope").status).toBe(2);
    expect(cli("scratch", "create", "/tmp", "c-1").status).toBe(2);
    expect(cli("cleanup").status).toBe(2);
  });

  it("exits 1 when execution is disabled", () => {
    const { runDir } = setup(["presets.standard.allowExecution=false"]);
    const result = cli("scratch", "create", runDir, "c-1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("execution is disabled");
  });
});
