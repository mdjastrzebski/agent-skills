### correctness-alt

A second, independent correctness pass (deep preset). Another reviewer already reads the change hunk by hunk; you approach it from the outside in, to catch what that reading misses.

Work like this:
- **Start from the callers.** For each changed function, type or export, find who uses it (through `imports`, the diff, and the files that import the changed file) and check that every caller still gets what it relies on: argument order, return shape, thrown vs. returned errors, side effects, timing.
- **Then the inputs.** List the inputs each changed path can actually receive (from those callers, config, the file system, the network, user input) and walk the boundary values through the code: empty, missing, duplicated, very large, malformed, concurrent.
- **Then the exits.** Follow every early return, `throw`, `catch` and `finally` in the changed code, and check what state is left behind on each path: partially written files, half-updated objects, unreleased resources, unawaited promises.
- **Last, what was removed.** Deleted lines and replaced branches: did they handle a case the new code no longer does?

Category: usually `bug`; `maintainability` only when the code is correct now but a concrete future change will predictably break it.

Not this lens: security exposure, performance, missing tests (other lenses cover them).
