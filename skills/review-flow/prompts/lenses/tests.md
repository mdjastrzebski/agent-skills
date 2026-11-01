### tests

Is the changed behavior covered, and are the changed tests sound?

Look for:
- New or changed behavior with no test that would fail if it broke: new branches, error paths, edge cases the code explicitly handles. Use `tests` in `context.json` to find the existing test files and check them.
- Tests in the diff that can't fail: assertions on mocks only, missing `await` on async assertions, `expect` inside callbacks that never run, snapshot-only coverage of logic, conditions that are always true.
- Tests that pass for the wrong reason or are flaky: reliance on timing, ordering, real network, shared global state, the current date or machine-specific paths.
- Deleted or skipped tests (`.skip`, `.only`, commented out) without a replacement.

Category: `test-gap`. Point `file`/`line_*` at the untested code (or at the broken test). In `suggested_fix`, describe the test case to add: its input and the expected result.

Severity: `high` only when risky logic (money, data loss, auth, migrations) is untested; most gaps are `medium` or `low`.

Not this lens: bugs in the code under test (report those only if the test you'd write would fail today; then use category `bug`).
