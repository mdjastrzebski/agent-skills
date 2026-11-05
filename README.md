# agent-skills

A collection of agent skills for coding agents.

Each skill lives in its own directory under `skills/` and is designed to be installed individually with the [`skills` CLI](https://skills.sh/docs). The repository currently includes focused, task-specific skills rather than a single bundled workflow.

## Install

Install an individual skill with `npx skills add` and the `--skill` flag:

```bash
npx skills add https://github.com/mdjastrzebski/agent-skills --skill react-review
```

The `skills` CLI runs with `npx`, so there is no separate global install step.

For more on the CLI, see:

- [skills.sh documentation](https://skills.sh/docs)
- [skills.sh CLI reference](https://skills.sh/docs/cli)

## Skills

| Skill | Summary | Install |
| --- | --- | --- |
| `fix-issues` | Work through a list of issues one by one: triage and order them (bugs first, then by severity), have a subagent verify and fix each one or explain why not, commit each fix separately on the current branch, and summarize the results. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill fix-issues` |
| `implement-idea` | Turn a rough feature or fix idea into an approved spec through a one-question-at-a-time clarifying interview (max 20 questions, the rest decided as stated assumptions), then delegate the build to a subagent sized to the task's difficulty and report how to test it. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill implement-idea` |
| `index-codebase` | Study a whole repository and write durable agent docs to `docs/agents/` (architecture, area map, design decisions, where to look, configuration and extension, limitations, security, dev loop, contribution rules, release process), linked from `AGENTS.md`; checks and fixes any existing agent docs, and refreshes everything when the code changes. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill index-codebase` |
| `index-github` | Assess a GitHub project before adopting or contributing to it (activity and responsiveness, maintainers and backing, maturity, alternatives, license and CLA, community, what contributions are welcome, bug hotspots) and write a dated snapshot to `docs/agents/project-health.md`, linked from `AGENTS.md`. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill index-github` |
| `instrument-with-console-logs` | Add temporary `👀 DEBUG` console.log statements across changed code and surrounding lifecycle code to validate runtime behavior, then strip them again. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill instrument-with-console-logs` |
| `react-review` | Review React and React Native code for correctness bugs rooted in effects, identity, state preservation, tree stability, and lifecycle timing. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill react-review` |
| `story` | Explain how a system, module, service, or unfamiliar codebase works by telling the story of the system: a few core concepts first, then more detail on request. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill story` |
| `trim-comments` | Review the comments in a change, delete the non-essential ones, and tighten the rest — defaults to the current PR / feature branch. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill trim-comments` |

## Repository Layout

```text
skills/
  <skill-name>/
    SKILL.md
    references/        # optional
    scripts/           # optional
    agents/            # optional
```

- `SKILL.md` is the canonical instruction file for a skill.
- `references/` holds targeted supporting material that can be loaded on demand.
- `scripts/` holds optional helper scripts for deterministic work such as fetching and aggregating data.
- `agents/` holds optional agent-specific metadata or integration config.

## Authoring

This repository is primarily maintained through coding agents.

If you are adding or updating skills here, follow the repo playbook in [AGENTS.md](/Users/mdj/Development/OpenSource/agent-skills/AGENTS.md).
