### correctness

Does the changed code do what it intends, for every input it can receive?

Look for:
- Logic errors: wrong conditions, inverted checks, off-by-one, wrong operator, wrong variable, missing `return`/`await`/`break`.
- Unhandled cases: `null`/`undefined`/empty input, error paths, exceptions that escape, promises that reject unobserved, partial failures that leave state half-updated.
- Broken contracts: a changed function signature, return shape or side effect that existing callers (find them through `imports` and the diff) still rely on.
- State and concurrency: stale reads, races between async operations, shared mutable state, ordering assumptions, resources that are opened and not closed.
- Data handling: wrong parsing or serialization, lossy conversions, time zones, encodings, number precision.

Category: usually `bug`; `maintainability` only when the code is correct now but a concrete future change will predictably break it.

Not this lens: security exposure, performance, missing tests (other lenses cover them).
