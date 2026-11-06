# Skill Structure

Use this guide when creating, renaming, or reorganizing skills.

## Required Layout

Create each skill in its own directory:

```text
skills/<skill-name>/
  SKILL.md
```

Rules:

- Use kebab-case for directory names.
- The skill directory name and frontmatter `name` should match unless there is a strong reason not to.
- Every skill must have a `SKILL.md`.
- Do not create empty optional folders.

## Active vs Legacy

- Active skills live at `skills/<skill-name>/`; legacy skills live at `skills/legacy/<skill-name>/`.
- `legacy` is a reserved directory name, not a skill.
- New skills always go in `skills/`, never straight to legacy.
- To retire a skill, `git mv` it into `skills/legacy/` and move its README row to the Legacy table. To revive it, move it back.
- Skill names must stay unique across both locations.

## Default Direction

- Prefer adding one focused skill over one broad, catch-all skill.
- Preserve existing skill structure and tone when editing.
