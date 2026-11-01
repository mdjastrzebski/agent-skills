import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDefaults } from "../src/config.js";
import type { Context } from "../src/context.js";

/** A fake run directory inside a real git repo, so the run-dir guard accepts it. */
export function runDir(
  lenses = ["correctness", "security", "tests"],
  maxVerified = 25,
): { dir: string; context: Context } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-flow-run-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const dir = join(root, ".review-flow/runs/current-20261101-123456");
  mkdirSync(join(dir, "findings"), { recursive: true });
  const context = {
    version: 1,
    run_id: "current-20261101-123456",
    run_dir: dir,
    created_at: "2026-11-01T12:34:56.000Z",
    harness: "claude",
    skill_dir: "/skill",
    repo_root: root,
    code_root: root,
    target: {
      mode: "current",
      branch: "feature",
      base: "main",
      base_ref: "origin/main",
      merge_base: "a".repeat(40),
      head_sha: "b".repeat(40),
      dirty: true,
    },
    rigor: "medium",
    limits: { maxVerified, parallel: 4, allowExecution: true },
    models: { reviewer: "sonnet", merger: "haiku", verifier: "opus" },
    scoring: loadDefaults().scoring,
    lenses: lenses.map((name) => ({
      name,
      prompt: `/skill/prompts/lenses/${name}.md`,
      output: `findings/${name}.json`,
    })),
    specs: [],
    stack: null,
    checks: { typecheck: null, test: null },
    ignore: [],
    diff: "diff.patch",
    files: [],
  } satisfies Context;
  writeFileSync(join(dir, "context.json"), JSON.stringify(context));
  return { dir, context };
}

export function writeFindings(dir: string, lens: string, value: unknown) {
  writeFileSync(join(dir, "findings", `${lens}.json`), typeof value === "string" ? value : JSON.stringify(value));
}

export function writeVerdict(dir: string, id: string, value: unknown) {
  mkdirSync(join(dir, "verdicts"), { recursive: true });
  writeFileSync(join(dir, "verdicts", `${id}.json`), typeof value === "string" ? value : JSON.stringify(value));
}
