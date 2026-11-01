# AGENTS.md

This repository is a collection of installable agent skills.

Read only the guide relevant to your task:

- [Skill Structure](docs/agents/skill-structure.md)
- [Skill Authoring](docs/agents/skill-authoring.md)
- [Supporting Files](docs/agents/supporting-files.md)
- [README Catalog](docs/agents/readme-catalog.md)
- [Review Checklist](docs/agents/review-checklist.md)

Repo-wide notes:

- The root `package.json` only provides oxlint/oxfmt (`npm run lint`, `npm run format`, `npm run format:check`), scoped to `skills/review-flow/scripts`. Add a skill's path to those scripts to opt it in. No build or typecheck commands are defined at the root.
- If your task adds, removes, or renames a skill, also read [README Catalog](docs/agents/readme-catalog.md).
