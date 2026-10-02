# Doc templates

Templates for `index.md`, `using.md`, and `contributing.md`. Each generated file starts with the marker from step 7 of `SKILL.md`. Drop any section that would be empty or padding.

## `index.md`

```markdown
# <Project>: Agent Index

## What this is
One paragraph: the problem it solves, who the intended user is, its shape (library / CLI / service / app / monorepo), and its language and runtime.

## Architecture in brief
The few core concepts and how they interact, then the primary flows step by step.

## Map
| Area | Responsibility | Paths | Doc |

## Where to look
| Task or question | Start at |
(e.g. "add a CLI flag", "change how X is cached", "why does Y retry?")

## Dev loop
The 3–5 commands used most, taken from CI and scripts. Full setup is in `contributing.md`.

## Conventions and traps
Generated files, required codegen steps, non-obvious rules.

## Glossary
| Term | Meaning | Defined in |

## Further reading
Hand-written agent docs, `project-health.md` if `index-github` has run, other in-repo docs, and the external docs site. Link to them rather than restating them.
```

## `using.md` and `contributing.md`

Fill each section with what step 5 found under "Using it" and "Contributing to it".

```markdown
# <Project>: Using and Extending

## Platforms and integrations
| Platform / integration | Supported versions | Where it lives |

## Configuration
| Setting | Where it's read | Default | Notes |

## Extension points
## Limitations and gotchas
## Security and trust
```

```markdown
# <Project>: Contributing

## Setup
## Feedback loop
| To check… | Run | Notes |

## Rules
Link to `CONTRIBUTING.md` rather than copying it.

## Release process
```
