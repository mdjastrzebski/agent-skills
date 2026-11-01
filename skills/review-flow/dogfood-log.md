# Dogfood log

False positives, misses and process notes from running review-flow on its own changes (SPEC §14). Entries become eval fixtures in step 11.

## Step 3: walking skeleton (2026-11-01)

Run: `current --base HEAD` (uncommitted step-3 diff, 27 files), rigor medium, Claude Code, reviewers on sonnet. Lenses: correctness 3, security 3, tests 4, performance 2, spec 2. 14 findings, 1 medium and 13 low, none invalid.

Fixed (real findings):
- correctness-1: spec/test detection used the index file list, so files deleted in the working tree could be handed to reviewers.
- correctness-2: `--base=` (empty inline value) skipped detection instead of failing as a usage error.
- correctness-3: `report.mjs` crashed with a stack trace when `context.json` was missing or corrupt.
- security-1: changed symlinks were followed when reading file context (could pull out-of-repo files into reviewer context).
- spec-1: SPEC status and PROGRESS.md not updated (expected at this point in the step; done before the commit).
- spec-2: spec auto-detection was case-insensitive, so the lens prompt `prompts/lenses/spec.md` was treated as a spec. Now case-sensitive (`SPEC.md`, `PRD.md`, `REQUIREMENTS.md`, `*.spec.md`, `specs/**.md`).
- tests-1..4: added tests for origin/<base> preference, custom lenses + `lenses.enabled`, harness models, invalid-findings rendering.

Deferred (valid, not worth it yet):
- performance-1: one `git diff --no-index` spawn per untracked file. Fine for normal trees; revisit with `git add -N` on the private index if a repo has many untracked files.
- performance-2: `matchTests` scans all repo files per changed file. Only matters for huge monorepos with huge diffs.
- security-2: reviewer text goes into `report.md` unescaped. The report is local; escaping belongs in `renderReview` (step 9) before anything is posted.
- security-3: custom lens paths aren't confined to the repo. The config comes from the user's own checkout; revisit in step 8, when reviewed PR content could bring a config along.

Found by dogfooding, outside the report:
- **Miss (caught by running it, not by reviewers):** `prepare.mjs` bundles `config.ts`, and config's entry guard compared `argv[1]` with `import.meta.url`, which inside a bundle is the bundle's own URL, so `config main` ran as well and printed its usage. Fixed with `isEntry(url, name)` in `src/cli.ts`, which also checks the module's own file stem. None of the reviewers flagged it. Good eval fixture: "module-level side effect duplicated by bundling".
- **Miss (caught by a mutation check):** `GIT_OPTIONAL_LOCKS=0` does not stop `git diff` from rewriting a stale index. prepare now runs all git reads against a throwaway copy of the index (`GIT_INDEX_FILE`).

False positives: none clear-cut. Most findings were low-severity and valid, which is expected without a verifier.
