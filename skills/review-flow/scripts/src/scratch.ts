/**
 * Stage 4 helper: throwaway worktrees where a verifier may write repros and run the check commands.
 *
 * Usage: node scripts/dist/scratch.mjs create <runDir> <candidateId>
 *        node scripts/dist/scratch.mjs remove <runDir> <candidateId>
 *
 * `create` adds a detached worktree at `<runDir>/scratch/<id>/` that reproduces the reviewed code (see worktree.ts),
 * replacing an existing one for the id. Prints a summary, then the worktree path as the last line of stdout.
 * `remove` deletes the worktree and its git metadata, whatever the verifier left in it.
 * Exit 0 on success, 1 when the worktree can't be created (execution disabled, git failure), 2 on usage errors.
 */
import { isEntry } from "./cli.js";
import { RunDirError } from "./run-dir.js";
import { createScratch, removeScratch, ScratchError } from "./worktree.js";

const USAGE = "usage: scratch.mjs create|remove <runDir> <candidateId>";

export function main(argv: string[]): number {
  const [command, runDir, id] = argv;
  if (argv.length !== 3 || (command !== "create" && command !== "remove")) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (command === "remove") {
      console.log(removeScratch(runDir, id) ? `removed scratch worktree for ${id}` : `no scratch worktree for ${id}`);
      return 0;
    }
    const scratch = createScratch(runDir, id);
    console.log(`scratch worktree for ${id}: HEAD + uncommitted changes (${scratch.copied} untracked file(s) copied)`);
    console.log(
      scratch.nodeModules.length
        ? `node_modules packages linked from the user's checkout (don't modify them): ${scratch.nodeModules.join(", ")}`
        : "no node_modules in the user's checkout: dependencies are unavailable, so don't execute (remove this worktree)",
    );
    console.log(scratch.path);
    return 0;
  } catch (error) {
    if (error instanceof RunDirError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof ScratchError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (isEntry(import.meta.url, "scratch")) {
  process.exitCode = main(process.argv.slice(2));
}
