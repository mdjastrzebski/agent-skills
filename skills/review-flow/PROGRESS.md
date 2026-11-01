# review-flow implementation progress

Implements [SPEC.md](SPEC.md), following its build order (§14: dogfooding-first steps). One step per session; each step ends with its tests passing, a dogfood run (logged in [dogfood-log.md](dogfood-log.md)), and a commit.

Dev commands (run in `scripts/`): `npm install`, `npm run build` (bundles `dist/*.mjs` and regenerates `../schemas/*.json`), `npm test`, `npm run typecheck`. Lint and format run from the repo root: `npm run lint` (oxlint), `npm run format` / `npm run format:check` (oxfmt).

Before §14 existed, work followed a different phase plan. Its phases 1–2 (schemas + `validate.mjs`, layered config) are done and serve as foundations for every step; their notes are kept below.

| Step | Scope | Status |
|---|---|---|
| — | Foundations: tooling, zod schemas, `validate.mjs`, config layering, `config init`/`show` | ✅ done |
| 1 | Prepare stage, `current` mode | ✅ done (minimal, built in step 3) |
| 2 | Review stage: reviewer + lens prompts, subagent per lens, validation | ✅ done (built in step 3) |
| 3 | Walking skeleton: minimal `report.mjs`, SKILL.md wiring 1 → 2 → report, first dogfood run | ✅ done |
| 4 | Verification (read-only verifiers, verdicts, placeholder ranking) | ✅ done (dogfood run pending) |
| 5 | Dedup + scoring + rigor, vitest for dedup/scoring/rendering | ⬜ |
| 6 | Executed verification (`scratch.mjs` worktrees) | ⬜ |
| 7 | Config + models per role applied to subagents | ⬜ (config itself done in foundations) |
| 8 | Branch and PR modes | ⬜ |
| 9 | Publish to GitHub | ⬜ |
| 10 | Cursor support | ⬜ |
| 11 | Eval + tuning | ⬜ |

## Notes

### Foundations: tooling + schemas (was phase 1)
- Package lives in `scripts/` (`package.json`, lockfile); `node_modules/` is git-ignored, `dist/` is committed.
- Bundler is tsdown (`tsdown.config.ts`). Add new CLIs to its `entries` list; each gets its own build so `dist/<name>.mjs` stays single-file (no shared chunks). `deps.onlyBundle: ["zod"]` fails the build if anything else gets bundled. The config is loaded with `--config-loader unrun` because Node's native loader can't resolve the `.js` → `.ts` imports used in `src/`.
- `validate.mjs <findings|candidates|verdict> <file>`: exit 0 valid, 1 invalid (one `path: message` line per issue on stderr), 2 usage/IO error.
- Schemas are strict: unknown keys are errors, so agents catch typos. Extra checks beyond §7: finding `id` must be `<lens>-<n>`, `line_end >= line_start`, ids unique within a findings/candidates file, `source_ids` non-empty.
- Candidate `id` is a free string (dedup in phase 4 picks the format); its `lens` is the primary source's lens.
- CLI entry guard: superseded by `isEntry` (see step 3).
- JSON Schemas are generated with zod 4's `z.toJSONSchema` into `schemas/{finding,candidate,verdict}.schema.json`; a test fails if they drift from the zod source.

### Foundations: config (was phase 2)
- `defaults.json` (skill root) holds the full effective config, including the §4 rigor table as `rigorPresets.{low,medium,high}` (`lenses`, `secondCorrectnessPass`, `allowExecution`, `maxVerified`, `parallel`) and the §8 weights as `scoring.{severity,confidence,impact,fixBeforeMergeThreshold}`. Step 5's exported weights constant should come from the loaded config, not a second copy.
- Zod sources: `Config` (effective, strict) and `ConfigFile` (deep-partial + `$schema`, strict) in `src/config-schema.ts`. `schemas/config.schema.json` is generated from `ConfigFile`.
- `loadConfig({ repoRoot, userConfigPath?, sets? })` in `src/config.ts` returns `{ config, sources, files }` or throws `ConfigError` (all issues at once, each prefixed with the file path or `--set …`). Phase 3's `prepare` should call it rather than re-reading files.
- Merge rules: objects merge key by key, arrays replace. `$schema` is dropped.
- User file: `$XDG_CONFIG_HOME/review-flow/config.json`, defaulting to `~/.config/...`.
- Files are parsed as JSONC (comments and trailing commas), because `init` writes commented-out defaults as §4a asks. VS Code flags comments in plain `.json` unless the file is associated with `jsonc`. The skill README should mention `"files.associations": { "review-flow.config.json": "jsonc" }`.
- `--set key=value` types the value by the schema node it targets: strings and enums stay raw, arrays take a JSON array or a comma list, `null` is accepted where the field is nullable, and everything else is JSON-parsed.
- `checks.typecheck` / `checks.test`: absent = auto-detect, `null` = disabled. `base` absent = auto-detect. `show` prints these as `(auto-detect)`.
- `lenses.enabled` only accepts built-in lens names. Custom lenses are paths in `lenses.custom`. Effective lenses (`preset.lenses ∩ enabled`, `spec` only when spec documents are found, plus custom) are resolved by `prepare`; relative custom paths resolve against the repo root.
- `src/detect.ts` (`detectStack`, `detectChecks`, `detectBase`) is shared with `prepare`. `init` writes the detected `base` and `checks`, plus `ignore: ["ios/Pods/**", "**/*.snap"]` for RN. Detected keys are written last and `$schema` at the very end, so uncommenting any default line keeps the file valid. A test checks this.
- §13 `$schema` question, resolved as proposed: the reference is relative when the skill folder is inside the repo, otherwise a `file://` URL to the installed schema. The latter is machine-specific in a committed file. Flag this in the README.
- zod issue formatting moved to `src/issues.ts`. Never import another CLI module (e.g. `validate.ts`) into a script: its entry guard would run inside the importing bundle.

### Step 3: walking skeleton (includes steps 1–2)
- SPEC.md §14 marked steps 1–2 done, but neither existed in the repo; the user chose to build them as part of step 3.
- **Lens change (user request):** the `react-native` lens was replaced by `spec` (adherence to the spec). It runs at medium and high rigor, only when spec documents exist: config `specs` (repo-relative paths; absent = auto-detect, `[]` = none), else auto-detected `SPEC.md`, `PRD.md`, `REQUIREMENTS.md`, `*.spec.md`, `specs/**.md` (case-sensitive) in a directory containing a changed file, nearest first, max 10. Listed in `context.json` as `specs`. SPEC §3, §4, §4a and §6 updated. `detectStack().reactNative` stays (used by `config init` for RN ignores). No `spec` finding category was added; the lens maps to `bug` / `maintainability` / `test-gap`.
- `prepare.mjs`: `current` mode only (`--target` anything else exits 1 "not supported yet"). Flags: `--base <ref>` (`HEAD` = uncommitted only), `--rigor`, `--lenses`, `--harness claude|cursor`, `--set`, `--repo`. A bare base name prefers `origin/<name>`, then the local branch. Diff = `git diff <merge-base>` + `git diff --no-index /dev/null <file>` per untracked file, both filtered by `ignore` globs (`:(exclude,glob)` pathspecs) and `.review-flow`. Exit 1 "nothing to review" on an empty diff (no run dir created).
- **Index safety:** `git diff` rewrites a stale index even with `GIT_OPTIONAL_LOCKS=0`, so every git read in prepare runs against a temp copy of the index (`withPrivateIndex` in `src/git.ts`). The byte-identical test makes the index stale with `utimesSync`; a mutation check confirmed it fails without the private index.
- `context.json` (type `Context` in `src/context.ts`, snake_case keys): run ids/paths, `target` (branch, base, base_ref, merge_base, head_sha, dirty), `rigor`, `limits`, `models` (for the harness), `lenses` (`name`, absolute `prompt`, `output` relative to the run dir), `specs`, `stack`, `checks` (config overrides detection; `null` = disabled), `ignore`, `diff`, and `files[]` with `status`, new-side `hunks`, `lines`, `truncated` (> 800 lines), resolved relative `imports` (NodeNext `.js` → `.ts`), and matching `tests` (same stem, `*.test.*` / `*.spec.*` / `__tests__/`, nearby first, max 5). Symlinks and deleted files are never read. It is a plain TS type, not a zod schema; step 4+ can add one if agents ever write it.
- Second correctness pass (high rigor) is not wired yet; step 5 does rigor.
- Run dir: `<repo>/.review-flow/runs/current-<UTC yyyymmdd-hhmmss>[-n]/` with `findings/`. `.review-flow/` is added to `$(git rev-parse --git-path info/exclude)` once (an existing `/.review-flow/` line counts). `resolveRunDir` (in `src/run-dir.ts`) is the guard every later script should use: it refuses anything not strictly inside `<repo>/.review-flow/runs/`.
- `trace.jsonl`: `prepare` and `report` append `{step, status, started_at, duration_ms, …}`. Subagent lines are not recorded yet.
- `report.mjs <runDir>`: validates every `findings/*.json` (expected lenses first, extras after), sorts by severity, file, line, id; writes `report.md` grouped by severity then file, with a header and a "Reviewer problems" section for missing or invalid files; prints a ≤10-line summary ending with the report path. No timestamps, so re-runs are byte-identical. No `report.json` yet; step 5/6 defines its shape.
- **Bundling bug found by dogfooding:** CLI modules imported by other CLIs (e.g. `config.ts` inside `prepare.mjs`) ran their own `main`, because inside a bundle every module shares `import.meta.url`. Every CLI now ends with `if (isEntry(import.meta.url, "<name>"))` (`src/cli.ts`), which also checks the file stem. Shared library code lives in non-CLI modules (`validation.ts` was split out of `validate.ts`).
- tsconfig target is ES2023 so `toSorted` (required by oxlint's `no-array-sort`) typechecks.
- Repo-root `review-flow.config.json` keeps `dist/`, generated schemas and lockfiles out of dogfood diffs.
- SKILL.md: Claude Code, `current` mode only, general-purpose subagents with `model: models.reviewer`, at most `limits.parallel` at a time, prompt that points at `prompts/reviewer.md` + the lens file by path (the subagent reads them; the parent doesn't paste them). Root README catalog entry added.

### Step 4: verification
- **Stub `dedup.mjs <runDir>`** (stage 3 placeholder until step 5): one candidate per valid finding, no clustering, ordered by severity/file/line/finding id (`compareFindings`), cut to `limits.maxVerified`. Candidate ids are `c-<n>` in that order; `source_ids` = the finding id. Writes `candidates.json`, recreates `candidates/` with one `candidates/<id>.json` per candidate, and creates `verdicts/`. Last stdout line: `candidates: <id> <id> …` (just `candidates:` when empty). Exit 2 on usage/run-dir errors.
- **`candidates/<id>.json` is new in the run dir** (added to SPEC §5): acceptance criterion 2 says no verifier input may contain another candidate, so verifiers can't read `candidates.json`. `verifier.md` also forbids `findings/`, other candidates, `verdicts/` and `report.md`. Step 5's real dedup must keep writing these per-candidate files.
- Stale verdicts are not detected: re-running `dedup.mjs` after findings change can renumber candidates while old `verdicts/c-<n>.json` stay. Fine while a run is one pass; revisit if runs become resumable mid-stage.
- `prompts/verifier.md`: disprove-by-default stance, read-only, no execution (`traced`/`reasoned` only; `executed` is forbidden by the prompt, not by the schema), untrusted content, the verdict fields with definitions, validate with `validate.mjs verdict` (max 2 retries), one-line reply.
- `collectFindings` / `compareFindings` / `SEVERITY_RANK` moved to `src/findings.ts` (shared by dedup and report; CLI modules must not import each other).
- **`report.mjs`** now requires `candidates.json` (exit 2 "run dedup.mjs first" otherwise) and reads `verdicts/<id>.json` per candidate. A verdict counts only if it validates and its `candidate_id` matches the file. Placeholder ranking: buckets Confirmed / Needs judgment (all `uncertain`) / Dismissed (`refuted`), each sorted by `severity_reassessed`, evidence type (executed < traced < reasoned), then `compareFindings`. Missing/invalid verdicts go to "Verification problems" and findings over the limit to "Not verified"; neither is ranked. Dismissed items render collapsed (`<details>`, title/location HTML-escaped). Summary: bucket counts, a `problems:` line when needed, confirmed then needs-judgment items, report path; ≤10 lines. Still no `report.json`.
- SKILL.md: stages 3 (dedup) and 4 (one fresh general-purpose verifier per candidate, `model: models.verifier`, ≤ `limits.parallel` at a time, re-spawn a missing verdict once) wired between review and report.
- Tests: `test/run-dir.ts` (fake run dir helpers, shared), `test/dedup.test.ts`, `test/report.test.ts` rewritten for candidates and verdicts.
- **Dogfood run not done in this session** (the session was scoped to "stop when tests pass"). Before step 5: run "review my changes" on a step-4-sized diff, check that every reported item has a verdict file and refuted items land in Dismissed, and log it in `dogfood-log.md`.

