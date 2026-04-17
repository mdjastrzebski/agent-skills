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
| `deep-probe` | Interview the user relentlessly about a plan or design, prioritizing the highest-leverage unknowns first and filling in lower-priority gaps on request. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill deep-probe` |
| `react-review` | Review React and React Native code for correctness bugs rooted in effects, identity, state preservation, tree stability, and lifecycle timing. | `npx skills add https://github.com/mdjastrzebski/agent-skills --skill react-review` |

`deep-probe` is adapted from Matt Pocock's `grill-me` skill: [mattpocock/skills](https://github.com/mattpocock/skills).

## Repository Layout

```text
skills/
  <skill-name>/
    SKILL.md
    references/        # optional
    agents/            # optional
```

- `SKILL.md` is the canonical instruction file for a skill.
- `references/` holds targeted supporting material that can be loaded on demand.
- `agents/` holds optional agent-specific metadata or integration config.

## Authoring

This repository is primarily maintained through coding agents.

If you are adding or updating skills here, follow the repo playbook in [AGENTS.md](/Users/mdj/Development/OpenSource/agent-skills/AGENTS.md).
