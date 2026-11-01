/**
 * End of stage 6: removes every worktree the run created (scratch worktrees a verifier left behind, later the PR
 * checkout) and prunes their git metadata. Every other run file is kept.
 *
 * Usage: node scripts/dist/cleanup.mjs <runDir>
 *
 * Prints how many worktrees were removed. Safe to run more than once.
 * Exit 0 on success, 2 on usage errors or an unusable run directory.
 */
import { isEntry } from "./cli.js";
import { appendTrace, resolveRunDir, RunDirError } from "./run-dir.js";
import { removeRunWorktrees } from "./worktree.js";

export function cleanup(runDirArg: string): string[] {
  const startedAt = new Date();
  const { runDir, repoRoot } = resolveRunDir(runDirArg);
  const removed = removeRunWorktrees(runDir, repoRoot);
  appendTrace(runDir, {
    step: "cleanup",
    status: "ok",
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    worktrees_removed: removed.length,
  });
  return removed;
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: cleanup.mjs <runDir>");
    return 2;
  }
  try {
    const removed = cleanup(argv[0]);
    console.log(`removed ${removed.length} worktree(s); run files kept`);
    return 0;
  } catch (error) {
    if (!(error instanceof RunDirError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (isEntry(import.meta.url, "cleanup")) {
  process.exitCode = main(process.argv.slice(2));
}
