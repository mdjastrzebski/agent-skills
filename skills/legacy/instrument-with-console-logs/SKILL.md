---
name: instrument-with-console-logs
description: Add temporary `👀 DEBUG` console.log statements to JavaScript/TypeScript code, and remove them again. Use when the user asks to instrument code, add debug or console logs, trace what actually runs at runtime, or see the order and values of a flow — typically to validate the behavior of the current PR or feature branch. Also use when asked to strip or clean up debug logs afterwards. Not for permanent application logging or telemetry.
---

# Instrument With Console Logs

Add throwaway `console.log` statements to JavaScript/TypeScript code so the user can run the app and see what actually happens: what runs, in what order, with what values.

This is scaffolding, not production code. It gets removed before the change ships, so it uses `console.log` even in repos that have a real logger — the marker is what makes the lines disposable.

## Two modes

Pick the mode from the request. Default to **instrument**.

- **instrument** — add `👀 DEBUG` logs
- **clean** — remove every `👀 DEBUG` log

## Mode: instrument

### 1. Determine the target

Default target is the current PR / feature branch: everything changed against the merge base with the main branch.

```bash
git merge-base HEAD main   # or master / develop, whatever the repo uses
git diff --stat <merge-base>...HEAD
git diff <merge-base>...HEAD
```

Also include uncommitted work (`git diff`, `git diff --cached`) — the user is usually validating what they just wrote.

If the user names a specific file, function, flow, or bug instead, that is the target and the diff is irrelevant.

If the target code is not JavaScript or TypeScript, say so and stop rather than improvising a logging call in another language.

### 2. Decide the blast radius

Instrument three rings, in this order:

1. **The changed code itself** — every changed function, branch, effect, handler, and early return.
2. **One hop out** — the direct callers of the changed code, and the non-trivial functions it calls. Enough to see the changed code's inputs where they are produced and its outputs where they are consumed.
3. **The enclosing unit** — the next meaningful boundary up: the screen, component, hook, route handler, saga, store slice, or service that owns the flow. Instrument its lifecycle: mount/unmount, render, effect run and cleanup, subscription setup/teardown, state transitions, and request start/finish.

The third ring is what makes the output readable — it gives the changed code a timeline to sit in. Do not skip it.

Stop there. Do not instrument the whole app, third-party code, or `node_modules`.

### 3. State the plan before editing

List the files and specific spots you intend to instrument, grouped by ring, in a few lines. Then edit. Keep it short — this is a heads-up, not an approval gate, unless the list is unexpectedly large (say, more than ~10 files), in which case confirm first.

### 4. Write the logs

Every line starts with exactly the marker `👀 DEBUG` — never a variant. It is the contract that lets the user filter the console and lets cleanup find every line later.

Format: marker, location, what happened, then relevant values in one object.

```js
console.log('👀 DEBUG useCartSync: effect run', { cartId, enabled });
console.log('👀 DEBUG useCartSync: effect cleanup', { cartId });
console.log('👀 DEBUG Cart.checkout: entry', { itemCount: items.length, total });
console.log('👀 DEBUG Cart.checkout: exit', { ok: result.ok, error: result.error?.message });
console.log('👀 DEBUG CartScreen: render', { status, itemCount: items.length });
```

Rules:

- **Location** is `Unit: event` — `Component`, `useHook`, `Class.method`, `module/function`. Use names that exist in the code.
- **Values go in an object**, not string concatenation, so they stay inspectable in the console.
- **Log what distinguishes runs**: ids, flags, lengths, status, error messages, the specific variable the change touches.
- **Log pairs** — entry/exit, run/cleanup, mount/unmount, request start/finish. A one-sided log rarely answers a timing question.
- **Log inside branches**, not before them, so the log proves which path ran.
- Prefer `console.log`. Use `console.error` only where the code is already in a failure path.

Avoid:

- Dumping whole objects, React props, large arrays, or component state wholesale. Pick fields.
- Logging secrets, tokens, auth headers, or personal data. Log `hasToken: !!token`, not the token.
- Logging inside hot loops or per-frame/per-scroll callbacks without a guard — it will drown the console. If unavoidable, log the first occurrence or a count.
- Changing behavior. No reordering, no extracting variables that alter evaluation, no logging inside a condition's expression. Instrumentation must be a pure addition of statements.
- `console.log` inside a render path that the repo's lint config forbids — if lint is strict, note it rather than suppressing it broadly.

### 5. Verify

Instrumentation that breaks the build wastes the whole pass. Before reporting:

1. Count what landed and compare it against the plan from step 3:

   ```bash
   grep -rcn '👀 DEBUG' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' .
   ```

2. Run whatever the repo already uses to check the files compile and lint — typecheck, lint, or a build. Scope it to the touched files when the repo supports that.
3. Fix anything the check reports, then run it again. Do not report until it passes.

If a log cannot be inserted without breaking the build or changing behavior, drop that log and say which one, rather than working around it.

### 6. Report

Tell the user:

- which files were instrumented and what each ring covers
- how to run the code and see the output
- `grep -rn '👀 DEBUG' <paths>` to see every inserted line
- that `/instrument-with-console-logs clean` (or "remove the debug logs") strips them

Do not commit the instrumentation unless the user asks. If the branch is otherwise clean, say so explicitly — the diff is now noisy on purpose.

## Mode: clean

1. Find every marked line:

   ```bash
   grep -rn '👀 DEBUG' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' .
   ```

2. Remove each one, along with anything that existed only to support it — a temporary variable, a widened destructure, a `/* eslint-disable */` added for the log, an import added for the log.

3. Verify nothing is left:

   ```bash
   grep -rn '👀 DEBUG' . && echo "still present" || echo "clean"
   ```

4. Check the diff is back to intended state: `git diff` should show no leftover blank-line churn or reformatting. Restore original formatting where the removal left a gap.

5. If a marked log lives in code the user changed for real reasons during the session, ask before deleting rather than assuming.
