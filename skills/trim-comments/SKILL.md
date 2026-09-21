---
name: trim-comments
description: Use when the user asks to trim, clean up, or reduce code comments, or says code is over-commented. Defaults to the current PR / feature branch; also takes an explicit scope.
---

# Trim Comments

Keep only comments a reader could not have gotten from the code. Touch comments only — no renames, no logic changes, no reformatting.

Apply the edits directly; do not propose a list first. The diff is the review surface.

## 1. Scope

Use the scope the user named. Otherwise: comments on lines this branch added or changed, plus uncommitted work.

```bash
git merge-base HEAD main   # or master / develop
git diff <merge-base>...HEAD
git diff; git diff --cached
```

Skip generated, vendored, and third-party files. Never touch license or copyright headers, or file-level banners the repo requires.

## 2. Judge each comment

Delete it when it:

- restates the code (`// increment counter` above `counter++`)
- labels an obvious block (`// imports`)
- narrates the change (`// new approach`) — that belongs in the commit message
- repeats a type the language enforces
- is a stale `// TODO: implement` over implemented code
- is commented-out code with no explanation

Keep it when it carries what the code cannot:

- why rather than what
- a workaround and what it works around
- a non-obvious constraint (ordering, invariants, thread/render safety, performance)
- a spec or ticket link
- a warning about a sharp edge someone would reintroduce
- a public API's doc contract

Tiebreaker: if it vanished, would the next reader make a mistake? If no, delete it.

Never touch directive comments — `eslint-disable`, `@ts-expect-error`, `prettier-ignore`, coverage pragmas.

## 3. Tighten what survives

- One line where one line does it.
- Drop preamble ("Note that", "This function").
- Match the repo's comment style.
- Never trade accuracy for brevity.

Before:

```ts
// This is a workaround. The upstream library resolves the promise before the
// listener is attached in some cases, so we need to attach it first and then
// call start(), otherwise we miss the first event.
// See https://github.com/acme/lib/issues/412
```

After:

```ts
// Attach before start(): lib resolves before listeners attach. acme/lib#412
```

## 4. Verify

- Lint/typecheck the touched files.
- Confirm `git diff` shows comment-only changes with no blank-line churn.
- Report counts removed and tightened, plus anything redundant-looking you kept.
