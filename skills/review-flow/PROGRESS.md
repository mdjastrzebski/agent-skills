# review-flow implementation progress

Implements [SPEC.md](SPEC.md). Do one phase per session; each phase ends with its tests passing and a commit.

Dev commands (run in `scripts/`): `npm install`, `npm run build` (bundles `dist/*.mjs` and regenerates `../schemas/*.json`), `npm test`, `npm run typecheck`. Lint and format run from the repo root: `npm run lint` (oxlint), `npm run format` / `npm run format:check` (oxfmt).

| Phase | Scope | Done when | Status |
|---|---|---|---|
| 1 | Scripts tooling (TS sources, esbuild → dependency-free `dist/*.mjs`, vitest), zod schemas + generated JSON Schemas, `validate.mjs` | Schema + validate tests pass, `dist/` builds | ✅ done |
| 2 | Config: `defaults.json`, 4-layer precedence, `--set`, unknown-key errors with suggestions, `config init` / `config show`, `config.schema.json` | Config tests pass | ✅ done |
| 3 | `prepare.mjs`: three modes (pr via mocked `gh`), run-dir guard, `.git/info/exclude`, stack detection, `context.json` | Temp-repo tests pass; working tree byte-identical before/after | ⬜ |
| 4 | `dedup.mjs` (clustering, possible duplicates, `--apply-merges`) + `scratch.mjs` | Clustering + worktree create/remove tests pass | ⬜ |
| 5 | `score.mjs` + `report.mjs` (weights constant, buckets, tie-breaks) + `cleanup.mjs` | Scoring/rendering tests pass; re-runs byte-identical | ⬜ |
| 6 | `publish.mjs` (`renderReview`, @mention escaping, dry-run, stale + duplicate checks) | Mocked-`gh` tests pass (§11 4a) | ⬜ |
| 7 | Prompts (reviewer, lenses, merger, verifier), SKILL.md, README, root README catalog entry | Review checklist passes | ⬜ |
| 8 | Eval harness + ≥5 fixtures, precision/recall output | `eval` runs on fixtures | ⬜ |

## Notes

### Phase 1
- Package lives in `scripts/` (`package.json`, lockfile); `node_modules/` is git-ignored, `dist/` is committed.
- Bundler is tsdown (`tsdown.config.ts`). Add new CLIs to its `entries` list; each gets its own build so `dist/<name>.mjs` stays single-file (no shared chunks). `deps.onlyBundle: ["zod"]` fails the build if anything else gets bundled. The config is loaded with `--config-loader unrun` because Node's native loader can't resolve the `.js` → `.ts` imports used in `src/`.
- `validate.mjs <findings|candidates|verdict> <file>`: exit 0 valid, 1 invalid (one `path: message` line per issue on stderr), 2 usage/IO error.
- Schemas are strict: unknown keys are errors, so agents catch typos. Extra checks beyond §7: finding `id` must be `<lens>-<n>`, `line_end >= line_start`, ids unique within a findings/candidates file, `source_ids` non-empty.
- Candidate `id` is a free string (dedup in phase 4 picks the format); its `lens` is the primary source's lens.
- CLI entry guard compares `realpathSync` paths, so `dist/*.mjs` still runs when the skill is installed through a symlink. Reuse this pattern for every later script.
- JSON Schemas are generated with zod 4's `z.toJSONSchema` into `schemas/{finding,candidate,verdict}.schema.json`; a test fails if they drift from the zod source.

### Phase 2
- `defaults.json` (skill root) holds the full effective config, including the §4 rigor table as `rigorPresets.{low,medium,high}` (`lenses`, `secondCorrectnessPass`, `allowExecution`, `maxVerified`, `parallel`) and the §8 weights as `scoring.{severity,confidence,impact,fixBeforeMergeThreshold}`. Phase 5's exported weights constant should come from the loaded config, not a second copy.
- Zod sources: `Config` (effective, strict) and `ConfigFile` (deep-partial + `$schema`, strict) in `src/config-schema.ts`. `schemas/config.schema.json` is generated from `ConfigFile`.
- `loadConfig({ repoRoot, userConfigPath?, sets? })` in `src/config.ts` returns `{ config, sources, files }` or throws `ConfigError` (all issues at once, each prefixed with the file path or `--set …`). Phase 3's `prepare` should call it rather than re-reading files.
- Merge rules: objects merge key by key, arrays replace. `$schema` is dropped.
- User file: `$XDG_CONFIG_HOME/review-flow/config.json`, defaulting to `~/.config/...`.
- Files are parsed as JSONC (comments and trailing commas), because `init` writes commented-out defaults as §4a asks. VS Code flags comments in plain `.json` unless the file is associated with `jsonc`. README (phase 7) should mention `"files.associations": { "review-flow.config.json": "jsonc" }`.
- `--set key=value` types the value by the schema node it targets: strings and enums stay raw, arrays take a JSON array or a comma list, `null` is accepted where the field is nullable, and everything else is JSON-parsed.
- `checks.typecheck` / `checks.test`: absent = auto-detect, `null` = disabled. `base` absent = auto-detect. `show` prints these as `(auto-detect)`.
- `lenses.enabled` only accepts built-in lens names. Custom lenses are paths in `lenses.custom`. Effective lenses (`preset.lenses ∩ enabled`, RN only when detected, plus custom) are resolved in phase 3. Phase 3 also decides what relative custom paths resolve against (proposed: the file that declared them, i.e. the repo root for the repo file).
- `src/detect.ts` (`detectStack`, `detectChecks`, `detectBase`) is shared with phase 3. `init` writes the detected `base` and `checks`, plus `ignore: ["ios/Pods/**", "**/*.snap"]` for RN. Detected keys are written last and `$schema` at the very end, so uncommenting any default line keeps the file valid. A test checks this.
- §13 `$schema` question, resolved as proposed: the reference is relative when the skill folder is inside the repo, otherwise a `file://` URL to the installed schema. The latter is machine-specific in a committed file. Flag this in the README.
- zod issue formatting moved to `src/issues.ts`. Never import another CLI module (e.g. `validate.ts`) into a script: its entry guard would run inside the importing bundle.
