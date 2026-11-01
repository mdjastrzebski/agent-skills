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

## Step 4: verification (2026-11-01)

Run: `current --base HEAD~1` (the step-4 commit plus the uncommitted base-ref fix below, 14 files), rigor medium, Claude Code, reviewers on sonnet, verifiers on opus. Lenses: correctness 1, security 1, tests 3, performance 0, spec 2. 7 candidates, all verified: 5 confirmed (1 medium, 4 low), 2 refuted, 0 uncertain, no missing or invalid verdicts. Refuted items landed in Dismissed as intended.

Fixed (confirmed):
- c-1 (correctness-1, medium): re-running `dedup.mjs` kept old `verdicts/c-<n>.json`, which then bound to whatever finding took that positional id. dedup now empties `verdicts/`.
- c-3 (tests-2): added a test for an invalid `candidates.json`.
- c-5 (tests-1): added a test for HTML escaping of dismissed titles.
- c-7 (spec-1): step 4 was ticked before its dogfood run; this run closes that.

Deferred (confirmed, low):
- c-4 (security-1): reviewer/verifier text goes into `report.md` unescaped, and a `</details>` in a dismissed item's claim or evidence would break the layout. Same call as step 3's security-2: the report is local, and escaping belongs in `renderReview` (step 9). The verifier rated the suggested blanket `html()` fix `incomplete` (it would garble inline code spans), which is a useful nuance.

Dismissed by verifiers (both correct):
- c-2 (spec-2): "unrelated prepare.ts fix bundled into step 4": it was uncommitted work in progress, not part of the step commit. The verifier checked with `git show --stat HEAD`.
- c-6 (tests-3): "CLI tests run stale dist": a pre-existing, deliberate convention, and src is covered by direct imports.

Found by dogfooding, outside the report:
- **Miss (caught by running it):** `prepare --base HEAD~1` reviewed against `origin/HEAD~1` (57 files instead of 14). `resolveBaseRef` tried `refs/remotes/origin/<base>` with `rev-parse --verify`, which also resolves revision expressions. Fixed with `show-ref --verify`, plus a regression test that fails without the fix. Bug from step 3; no reviewer had flagged it. Eval fixture idea: "ref-name lookup that accepts revision syntax".

Verifier observations: verdicts were well-argued, with file:line traces. Verifiers used read-only git commands (`git show`, `git status`) for context, which verifier.md allows. Total: 5 reviewers + 7 verifiers, about 30 s each.

## Step 5: dedup + scoring + rigor (2026-11-01)

Run: `current --base HEAD~1` (the step-5 commit, 18 files), rigor medium, Claude Code, reviewers on sonnet, verifiers on opus. Lenses: correctness 1, security 0, tests 2, performance 0, spec 2. Dedup: 5 candidates from 5 findings, no clusters, no possible duplicates. Scored: 0 fix before merge, 0 needs judgment, 4 follow-up (all low, confirmed/traced, score 0.85), 1 dismissed. No missing or invalid verdicts. First run with real scoring; buckets and score lines read well.

Fixed (confirmed follow-ups):
- c-2 (spec-2): SPEC §8 still said "one exported constant"; reworded to the `scoring` config section snapshotted into `context.json`.
- c-3 (tests-2): `compareRanked`'s last tiebreak (line within a file, reviewer severity masked) was untested. Added a test; a mutation check (dropping the mask) makes it fail.
- c-4 (tests-1): `readRanked`'s shape guard (wrong `version`, non-array `items`) was untested. Added both cases.
- c-5 (spec-1): SPEC ticked step 5 while PROGRESS said the dogfood run was pending. This run closes it; the checkbox now says "; dogfood run" like step 4's.

Dismissed by verifier (correct):
- c-1 (correctness-1): "`--lenses correctness` at high rigor silently adds correctness-alt". Deliberate and tested. Note the verifier partly justified it with PROGRESS.md, i.e. the implementer's own notes, not SPEC; SPEC §4 only says high rigor adds a second correctness pass. Fine here, but verifiers treating implementation notes as the spec is worth watching.

Observations:
- Nothing clustered, so this run didn't exercise dedup merging on real data; with high rigor (correctness-alt) it should. Try a high-rigor dogfood run in step 6.
- The scoring threshold (5) means low/medium confirmed findings can never be "fix before merge" unless user-facing and executed (medium × 1.0 × 1.2 = 3.6). Expected per §8, but revisit in step 11 tuning.
