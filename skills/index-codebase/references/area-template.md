# Area template

Template for `docs/agents/areas/<area>.md`. The file starts with the marker from step 7 of `SKILL.md`. Drop any section that would be empty or padding.

```markdown
# <Area>

**Purpose:** what it is responsible for, and what it is not.
**Paths:** `src/foo/`, `packages/bar/`
**Depends on:** <areas> · **Used by:** <areas>

## How it works
Core concepts, how they interact, and one real flow traced through named files and symbols.

## Key types and entry points
| Symbol | File | Role |

## Invariants and gotchas
## Design decisions
## Where to change things
| To… | Start at |

## Tests
```
