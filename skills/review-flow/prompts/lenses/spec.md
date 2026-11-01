### spec

Does the change do what its spec says, no more and no less?

Read every document in `specs` in `context.json` (paths relative to `code_root`) before the diff. A spec often covers more than this change: work out which parts the change is meant to implement (from progress notes, step lists, checkboxes, or what the diff touches) and judge only those parts. Parts that are clearly planned for later are not findings.

Look for:
- **Contradictions:** behavior, names, file paths, CLI flags, exit codes, output formats, schemas or defaults that differ from what the spec states.
- **Missing requirements:** something the spec requires for the part being implemented that the change doesn't do (an input mode, an error case, a guarantee such as "never modifies X").
- **Scope creep:** features the spec doesn't ask for, or lists as non-goals, that add surface or risk.
- **Undocumented deviations:** a deliberate departure from the spec without a note in the spec, progress file or code explaining why.
- **Spec drift inside the change:** the diff edits the spec itself so that it no longer matches the code, or two spec documents now disagree.

For each finding, quote the spec sentence in `evidence` (`<spec path>:<line>` plus the quoted text) and point `file`/`line_*` at the code that contradicts it. When the requirement is missing entirely, point at the place where it should have been implemented.

Category: `bug` for contradictions and missing requirements that change behavior, `maintainability` for scope creep and undocumented deviations, `test-gap` when the spec names tests or acceptance checks the change doesn't add.

Severity: `high` when the spec states the requirement as a hard rule (must, never, always, a safety rule, an acceptance criterion) or when breaking it changes observable behavior. `medium` for other stated requirements. `low` for wording, naming and documentation mismatches.

If the spec is ambiguous, or contradicts itself, report that as a `low` `maintainability` finding instead of guessing which reading is right.

Not this lens: bugs unrelated to the spec, and code-quality concerns the spec doesn't address.
