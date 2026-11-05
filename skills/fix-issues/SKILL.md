---
name: fix-issues
description: Use when the user gives a list of issues, review findings, bug reports, or TODOs and asks to fix them, work through them, or "fix these issues" one by one. Triages and orders the list, then verifies and fixes each issue in its own subagent, with one commit per fixed issue on the current branch.
---

# Fix Issues

Work through a list of issues one at a time. The main agent triages and orders the list, then dispatches one subagent per issue, sequentially. Each subagent decides whether its issue is real and worth fixing, and fixes it if so. The main agent commits each fix separately and ends with a short summary.

The main agent coordinates. It does not investigate or fix issues itself.

## 1. Collect the issues

Take the issues the user gave: a pasted list, code-review output, GitHub issue links, or a file. If there is no list, ask for one and stop.

Give each issue a short ID (`#1`, `#2`, ...) in the order the user gave them, and keep the user's wording. Split items that bundle several separate problems. Merge exact duplicates.

## 2. Preflight

- Note the current branch. Commit to it. Do not create, switch, or push branches.
- Check `git status`. If there are uncommitted changes, ask the user whether to commit, stash, or stop before going on. Do not mix them into issue commits.
- Find the repo's fast checks (lint, typecheck, relevant tests) and its commit message style (`git log --oneline -20`). Pass both to every subagent.

## 3. Triage and order

Before dispatching anything, classify each issue from its description and a quick look at the code it names. Do not analyze it deeply; that is the subagent's job.

- **Kind:** `bug` (wrong behavior, crash, security, data loss, regression) or `improvement` (refactor, performance, cleanup, docs, style).
- **Severity:** `critical` (security, data loss or corruption, crash in a common path), `high` (wrong result in a common path), `medium` (edge case, degraded behavior), `low` (cosmetic, minor).

Order:

1. All bugs before all improvements.
2. Within each kind, higher severity first.
3. Ties: issues that others depend on first, then smaller blast radius first.

Print the ordered plan as a short table (`ID | kind | severity | one-line issue`), then start dispatching without waiting for approval.

## 4. Dispatch, one issue at a time

For each issue in order, spawn one subagent and wait for it to finish before starting the next. Never run issue subagents in parallel: each one must see the code as earlier fixes left it.

Subagent prompt (fill in the brackets):

```text
You are handling one issue in [repo] on branch [branch]. Earlier issues in this batch may already be fixed and committed.

Issue [ID] ([kind], [severity]):
[issue text as the user gave it]

1. Analyze. Read the relevant code and confirm or refute the issue. Reproduce it when practical (a failing test, a script, or a traced code path).
2. Decide one verdict:
   - VALID: the issue is correct as stated and worth fixing.
   - PARTIAL: part of it is wrong, overstated, or misdiagnosed, but a real problem remains. Write the corrected issue definition, then fix that.
   - ALREADY_FIXED: the problem no longer exists, e.g. an earlier fix covered it.
   - INVALID: the issue is not real.
   - NOT_WORTH_FIXING: real, but the fix costs more than it gains (risk, churn, scope, or out of this repo's control).
3. If VALID or PARTIAL, fix it:
   - Make the smallest change that fully fixes the issue. No unrelated refactors or reformatting.
   - Add or update a test when the repo has tests for that area.
   - Run these checks on what you changed: [fast checks].
   - Do not commit, push, or switch branches.
   - If you cannot fix it cleanly or the checks fail, revert your changes and report FAILED.

Reply with exactly:
VERDICT: VALID | PARTIAL | ALREADY_FIXED | INVALID | NOT_WORTH_FIXING | FAILED
ISSUE: [the issue as stated, or the corrected definition if PARTIAL]
REASON: [1-3 sentences: evidence for the verdict, or why it is not worth fixing, or why it failed]
CHANGES: [files changed and what changed, or "none"]
CHECKS: [commands run and results, or "none"]
COMMIT: [one-line commit subject in the repo's style: [style]]
```

## 5. Commit after each issue

After each subagent returns:

- **VALID or PARTIAL:** check `git status` and `git diff`. The changes must match the reported CHANGES and stay within the issue. If the subagent left unrelated edits, revert them. Then stage only those files and make one commit on the current branch. Use the subagent's subject; for PARTIAL, add the corrected issue definition to the body.
- **Any other verdict:** make sure the working tree is clean (revert anything left over) and record the reason. No commit.

Never squash, amend, or combine commits across issues.

## 6. Summary

After the last issue, print a concise summary in triage order:

```text
| ID | Verdict | Commit | Note |
| #3 | VALID   | a1b2c3d fix: ... | |
| #1 | PARTIAL | d4e5f6a fix: ... | real cause was X, not Y |
| #2 | NOT_WORTH_FIXING | — | why |
```

Then one line with counts: fixed, partial, skipped (already fixed, invalid, not worth fixing), failed. List failed issues with the reason so the user can follow up.
