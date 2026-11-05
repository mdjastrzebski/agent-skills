---
name: implement-idea
description: Use when the user brings a rough idea for a feature, fix, refactor, or other change and wants it turned into a spec and built, or says "implement this idea", "I have an idea for…", "grill me on this, then build it". Runs a one-question-at-a-time clarifying interview (max 20 questions), gets the spec approved, then delegates the build to a subagent sized to the task.
---

# Implement Idea

Turn a rough idea into an approved spec, then hand it to a subagent to build. Four phases, in order: research, grill, approve, delegate. Do not write code yourself.

## 1. Ground yourself first

Before the first question, read enough of the codebase to avoid asking what the code already answers: where the change would live, existing patterns it should follow, how tests and the dev loop work (`AGENTS.md`, `CLAUDE.md`, `README`, package scripts). Never ask the user something you can look up.

## 2. Grill, one question at a time

Interview the user like a sharp senior engineer stress-testing the idea.

- **One question per message.** Wait for the answer before asking the next. Never batch.
- **Most important first.** Order by how much the answer changes the build: goal and success criteria → scope (what's in, what's explicitly out) → user-facing behavior → data and interfaces → edge cases and errors → non-functional (performance, security, compatibility) → polish.
- **Make every question cheap to answer.** Offer 2–4 concrete options and mark your recommendation, e.g. "Should failed syncs retry? (a) no, surface the error (b) 3 retries with backoff — recommended, matches `fetchWithRetry` (c) retry forever in background". Use a structured question tool if the agent has one.
- **Adapt.** Let each answer reshape the remaining questions. Skip anything an earlier answer already settled. Push back when an answer conflicts with an earlier one or with the codebase.
- **Hard cap: 20 questions.** Stop earlier once the remaining unknowns would not change the design. Most ideas need 3–10.
- **Decide the rest yourself.** For every detail not asked, pick the most reasonable option given the codebase and the answers so far, and record it as an assumption.
- If the user says "you decide" or "just build it", stop asking and move to the summary.

## 3. Present the spec for approval

After the last question, present a concise spec and stop until the user approves:

```markdown
## Spec: <title>

**Goal:** <one or two sentences — what changes and why>

**Scope**
- In: …
- Out: …

**Behavior**
- <concrete, testable statements of what the result does>

**Key decisions** (from your answers)
- <decision> — <short reason>

**Assumptions** (decided by me — correct any)
- <assumption> — <short reason>

**Acceptance criteria**
- <how we'll know it works>

**Implementation difficulty:** <simple | moderate | hard> → <agent and effort picked>
```

Approve, edit, or reject — do not start until the user says go. If they correct something, update the spec and re-present only the changed parts.

## 4. Delegate to a sized subagent

Pick the subagent's model and reasoning effort from the spec's difficulty. Spend on hard work, save on easy work:

| Difficulty | Signals | Pick (Claude Code example) |
| --- | --- | --- |
| Simple | one or two files, clear pattern to copy, low risk (copy change, config flag, small UI tweak, obvious bug fix) | economical model, low–medium effort — e.g. `haiku`, or `sonnet` at medium |
| Moderate | several files in one area, new but conventional logic, some tests to write | `sonnet` at medium–high effort |
| Hard | cross-cutting or architectural change, concurrency, data migrations, security-sensitive code, subtle algorithms, unfamiliar or poorly structured code | most capable model, high effort — e.g. `opus` at high |

When in doubt between two tiers, pick the higher one. If the agent has no subagent support, implement it yourself following the same brief.

Give the subagent a self-contained brief — it does not see this conversation:

- the full approved spec, verbatim
- the relevant files, patterns, and conventions you found in phase 1
- how to run tests, lint, and typecheck, and the instruction to run them before finishing
- constraints: stay within scope, do not commit or push unless the user asked, do not ask the user questions — make the reasonable call and report it
- what to return: files changed, a summary of the change, any deviations from the spec and why, test results, and steps to try the feature manually

## 5. Report back

When the subagent finishes, verify its claims briefly (look at the diff, confirm tests ran) and then report to the user concisely:

- **What changed:** two to four bullets, with key files
- **Deviations:** anything that differs from the spec, or "none"
- **Try it yourself:** the shortest concrete steps to see the feature working — a command to run, a screen to open, input to give, what to expect
- **Checks:** tests/lint/typecheck run and their result

Keep it short. Don't paste the diff or repeat the spec.
