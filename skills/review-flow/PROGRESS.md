# review-flow implementation progress

Implements [SPEC.md](SPEC.md). Do one phase per session; each phase ends with its tests passing and a commit.

Dev commands (run in `scripts/`): `npm install`, `npm run build` (bundles `dist/*.mjs` and regenerates `../schemas/*.json`), `npm test`, `npm run typecheck`.

| Phase | Scope | Done when | Status |
|---|---|---|---|
| 1 | Scripts tooling (TS sources, esbuild → dependency-free `dist/*.mjs`, vitest), zod schemas + generated JSON Schemas, `validate.mjs` | Schema + validate tests pass, `dist/` builds | ✅ done |
| 2 | Config: `defaults.json`, 4-layer precedence, `--set`, unknown-key errors with suggestions, `config init` / `config show`, `config.schema.json` | Config tests pass | ⬜ |
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
