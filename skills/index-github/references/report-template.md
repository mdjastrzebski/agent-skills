# Report template

Template for the report from step 8 of `SKILL.md`. Leave out any section that would be padding.

```markdown
<!-- index-github: snapshot of OWNER/NAME on YYYY-MM-DD, last N days. Numbers go stale; rerun index-github to refresh. -->
# <Project>: Project Health

**Verdict:** <verdict>, followed by one or two sentences on why.
**Risks:** concentration, license, or stability risks, if any.
**Snapshot:** <date>, covering <since> to <date>. <Truncation note, if any.>

## What it is
One paragraph: the problem it solves and its intended user. Link to `index.md` if it exists.

## Alternatives
| Project | Approach | Differences | Activity |

## Maturity
Version, 1.0 status, semver policy, breaking-release history, production use.

## Activity
### Maintainers
Who merges, reviews, and answers issues; the bus factor.
### Responsiveness
| PRs | External | Maintainer |
(first response, days to land, landed / closed unmerged / open)
Issues: first response, days to close, completed vs not planned.
### Backlog
Open issues and PRs by age, untriaged items, and items waiting with no response.
### Releases
Cadence, latest stable release, prerelease pattern.

## Backing and funding
Company, individual, or foundation; funding; any commercial or open-core angle.

## License
The main license and what it allows, extra license files, CLA or DCO, and flagged dependency licenses.

## Security
The reporting channel, past advisories, and how fast fixes shipped. Link to `using.md` for what it runs.

## Community
Where discussion happens, the code of conduct, and how decisions get made.

## Contributing in practice
What's welcome (good first issues, roadmap), what gets rejected (scope boundaries), how review actually goes, and how contributors are credited. Link to `contributing.md` for the written rules.

## Problem areas
| Area | Theme | Evidence |
The common ways it fails for users, mapped to code areas. Link to `areas/<area>.md` when those exist.

## Caveats
Which numbers or claims are unreliable for this repo, and why.
```

- Cite issues and PRs as links (`[#123](url)`). Round durations to whole days, or one decimal under 10 days.
- Name people by their public GitHub login. Never include email addresses; give company domains only as aggregate counts. Describe workload and patterns, never blame individuals.
- Recommend legal review when copyleft or source-available terms affect the user's use.
- Keep it to about 250 lines.
