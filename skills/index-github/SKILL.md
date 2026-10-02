---
name: index-github
description: Use when the user asks whether a GitHub project is worth adopting or contributing to, or how healthy, active, or well maintained it is — who maintains and backs it, how fast issues and PRs get answered or merged, maturity and breaking-change history, how it compares to alternatives, license and CLA, community channels, what contributions are welcome, or which parts produce the most bugs. Takes a named repo or package (such as a dependency being evaluated) or defaults to the GitHub repo of the current working directory (its upstream if it's a fork), over the last 12 months. A report on the current repo goes to `docs/agents/project-health.md`; a report on any other repo goes to a location the user confirms. Read-only on GitHub.
---

# Index GitHub

Assess a GitHub project for someone deciding whether to adopt it or contribute to it, and write a dated snapshot. A bundled script fetches the issue, PR, release, and repo metadata and computes the numbers. Your job is judgment: catch the cases where the numbers mislead, read samples to explain them, fill in what the numbers can't show (alternatives, backing, licensing, scope), and reach a verdict.

How the code works, how to set up a dev environment, the contribution rules, and what the project runs on your machine belong to `index-codebase`. Link to its docs when they exist rather than repeating them.

Never write to GitHub: no comments, labels, reactions, closing, or reruns. Use read-only calls only, and don't install anything.

**Be a light API user:**

- **One script run per target.** Answer follow-up questions from the raw JSON in `--out`, not by fetching again.
- **One run at a time.** Never run the script against several repos in parallel.
- **Mind the cost.** A run costs about 10 GraphQL points for a small repo and up to ~300 for a very large one, out of the 5,000 an authenticated user gets per hour. The script stops early if fewer than 300 remain.
- **Registries and download stats (npm, PyPI, pypistats, crates.io):**
  - make one request at a time, at most one per second
  - send a descriptive User-Agent (`curl -A "index-github-skill (+https://github.com/mdjastrzebski/agent-skills)"`), which crates.io requires. Never put the user's email in it.
  - look up only direct runtime dependencies, never the transitive tree

## 1. Preflight

```bash
gh auth status
gh repo view --json nameWithOwner,isFork,parent      # the repo you're in, if any
```

**Resolve the target.**

- If the user named `OWNER/NAME` or a GitHub URL, use it.
- If they named a package, find its repo in the registry metadata.
- If they named nothing, the target is the repo you're in.
- If the target is a fork, assess its parent unless the user explicitly named the fork.

**Pick the mode.** This decides where git commands run and where the report goes, so get it right before doing anything else.

- **Self mode:** the target is the repo you're in, or its upstream if that repo is a fork. Run the git commands in the working directory and write the report to `docs/agents/project-health.md`.
- **Dependency mode:** the target is any other repo, or you're not in a clone at all. Never run the git commands against the working directory, because it's the wrong repo. Instead, make a blobless clone of the target in a temp directory (your scratchpad, if you have one):

  ```bash
  git clone --filter=blob:none --no-checkout --quiet https://github.com/OWNER/NAME <tmp>/target
  ```

  For a very large repo, use `--filter=tree:0` instead, and skip step 4's fix hotspots, which are slow without trees. Then ask the user, once, where to save the report. Offer `docs/agents/deps/<owner>-<name>.md` in the current repo, or chat only.

Then, in either mode:

```bash
gh repo view OWNER/NAME --json nameWithOwner,isArchived,hasIssuesEnabled
```

- If it's archived, say so up front, then report anyway.
- Check the target's README and `CONTRIBUTING.md` for where the work actually happens. If issues or reviews live outside GitHub (Jira, a mailing list, Gerrit), say which GitHub signals won't mean much.
- **Reading the target's files:** in dependency mode, read them with `git -C <tmp>/target show origin/HEAD:<path>`, never from the working directory.
- **Self mode only:** if `docs/agents/index.md` exists, read it. It already answers "what is this" and maps the code areas. In dependency mode, any `docs/agents/` files in the current repo describe *your* project, so don't use them for the target.

## 2. Fetch and compute

Run the script `scripts/gh_health.py`, which sits next to this `SKILL.md`. Write its output to a temp directory (your scratchpad, if you have one), not to the repo.

```bash
mkdir -p <tmp>/index-github && python3 <skill-dir>/scripts/gh_health.py --repo OWNER/NAME --out <tmp>/index-github > <tmp>/index-github/summary.json
```

- **Options:** see `--help`. The ones you'll reach for are `--max` / `--max-open` (fetch caps) and `--ignore-users a,b` (logins to treat as bots, step 3).
- **Runtime:** ~15 s for a small repo, and up to ~5 min for a very large one (such as `kubernetes/kubernetes`). If GitHub returns 502s or timeouts, it halves the page size and carries on. Run it in the background if you can.
- **Raw data:** `--out` saves `meta.json`, `prs.json`, and `issues.json` for follow-up queries with `jq` or Python.

What's in `summary.json`:

- **`repo`:** owner type (organization or user), license, topics, homepage, `fundingLinks`, `codeOfConduct`, security policy, Discussions, `contactLinks` (where the issue templates send people, such as Discord or forums), and `pinnedIssues`.
- **`window`:** `truncated: true` means the stats cover only the newest `--max` items, going back to `oldest`. Say so in the report, or rerun with a larger `--max`.
- **`releases`:** cadence, the latest stable release (`latest_stable` is the highest version; `newest_stable` is the most recently created, which can be a backport), `reached_1_0`, and `breaking_series_first_releases`, which lists each major version (each minor while still on 0.x) with its first release date. If `fetched` is below `total`, the oldest series are missing; use git tags instead.
- **`prs.by_origin`:** PRs split into `maintainer` (OWNER / MEMBER / COLLABORATOR), `external`, and `bot`. External PRs are the real test of responsiveness.
  - **`landed`:** counts PRs merged on GitHub *and* PRs closed by a commit, for repos that land PRs outside GitHub. `landed_via_commit_close` shows how many came from the second group.
- **`prs.cla_signals`:** CLA or DCO labels and bot commenters seen on PRs.
- **`prs.top_labels`, `issues.top_labels`, and `backlog.open_issue_labels`:** how the project triages.
- **`people`:** who merges, reviews, and answers issues. `landed_by_bot` counts PRs landed by a bot account.
- **`prs.hotspots`:** path prefixes ranked by landed fix PRs (by bug label, by `fix:` title, or by closing a bug issue), with all landed PRs alongside. Big packages rank high just for being big, so compare `fix_prs` to `landed_prs`.
- **`prs.samples`, `issues.most_reacted_open`, and `issues.titles_for_clustering`:** inputs for step 5.
- **`backlog`:** age and triage counts over all open items, plus `welcome_issues` (good first issue, help wanted). A value like `">=N"` is a lower bound, because the open-item fetch was capped. When `open_issues_truncated` is true, `open_issue_labels` and `welcome_issues` cover only the oldest open issues; raise `--max-open` if they matter.
- **`security_advisories`:** published GitHub security advisories, or `null` when they couldn't be read.
- **`api`:** the calls made, the points used, and the quota remaining. If `stopped_low_quota` is true, the data is incomplete. Say so in the report, and don't rerun until the hourly quota resets.

## 3. Check the numbers

Check these traps before interpreting anything. Rerun or add a caveat as needed.

- **Bots on regular user accounts.** Scan `people.mergers`, the responders, and the PR authors. A sync, triage, or CI account (`*sync*`, `*-ci`, an account that lands far more PRs than it writes) skews everything. Rerun with `--ignore-users`.
- **Merge bots and queues.** If `people.mergers` is empty or tiny while `landed_by_bot` is high, a bot lands the PRs (Prow, bors, Mergify, a GitHub merge queue). The real decision-makers are then the reviewers, the `OWNERS` or `CODEOWNERS` files, and approval labels such as `lgtm` or `approved` in `prs.top_labels`.
- **Landing outside GitHub.** If `landed_via_commit_close` is close to `landed`, PRs are merged through internal tooling or a merge bot. Then GitHub reviews and comments undercount the real review, so take the maintainers from git history (step 4).
- **Self-merges.** If `maintainer.self_merged` is close to `maintainer.landed`, with `days_to_land` near zero, the maintainers merge their own PRs. That's normal for small teams, but it isn't fast review. Judge responsiveness by external PRs.
- **Maintainers GitHub doesn't recognize.** GitHub labels someone MEMBER only when their org membership is public. If `days_to_first_human_response` is much better than the maintainer-only number, check whether the frequent responders are really maintainers (`CODEOWNERS`, a `MAINTAINERS` file, git log), and say which number you trust.
- **Stale bots.** Many `closed_not_planned` issues plus a stale workflow (`.github/workflows/*stale*`, `.github/stale.yml`) means issues are being auto-closed, not resolved.
- **Short windows on busy repos.** If `window.*.truncated` is true and `oldest` is only weeks back (`microsoft/vscode` gets just ~10 days at `--max 1000`), `days_to_land` and `days_to_close` are biased low, because slow items haven't finished yet. Rerun with `--max 3000` or more, or report the open and unanswered counts instead of the medians.
- **Small samples.** If `n` is under ~10, report the counts and skip the medians.
- **Per-package release tags.** Monorepos often tag each package separately (`@scope/a@1.2.0`, `b-v0.3.0`). Then `latest_stable`, `reached_1_0`, and `breaking_series_first_releases` mix packages together. If the tags carry package names, recompute them for the main package from the releases in `meta.json` or from git tags, and ignore the script's values.

## 4. Git history

`<dir>` is `.` in self mode and `<tmp>/target` in dependency mode. In self mode, check that the clone is current first (`git log -1 --format=%cd origin/HEAD`). If it's old, ask before running `git fetch`, or give the date of the latest commit in the report.

Run every command as `git -C <dir> … origin/HEAD` (if `origin/HEAD` is missing, run `git -C <dir> remote set-head origin -a`). Get:

- **Committers:** last year with emails, and all-time. The **bus factor** is how many people account for 80% of last year's commits; merge rows that share an email, since one person often commits under several name spellings.
- **Who backs it:** whether email domains concentrate on one company. Use emails only to merge rows and count domains. Never copy an email address into the report or chat.
- **Monthly commit activity** over two years, **fix hotspots** (paths touched by `fix` / `revert` commits in the last year), and the **full tag history**.
- **Every license file** in the tree, and whether recent commits carry `Signed-off-by` (DCO).
- **Governance files:** `CODEOWNERS`, `MAINTAINERS`, `GOVERNANCE.md`, `.github/FUNDING.yml`, and any "maintenance mode" or "looking for maintainers" notice in the README or `repo.pinnedIssues`.

## 5. Read the samples

The numbers say what happens; samples say why. Read about 10–20 items in total, with their comments.

- **Issue themes:** cluster `titles_for_clustering` into 3–8 themes. Map each theme to code areas. In self mode, use the Map in `docs/agents/index.md` if `index-codebase` has run; otherwise, and always in dependency mode, use the hotspot paths. These themes are also the common ways it fails for users.
- **Most-wanted issues:** read the top 3–5 of `most_reacted_open`. Are long-requested features acknowledged, declined, or ignored?
- **Rejected and slow PRs:** read 3–5 from `closed_unmerged_external` and `slowest_landed_external`. Why were they rejected or slow? Scope policy, quality, a CLA, no maintainer time, or superseded by other work? Note how review goes in practice: who reviews, how many rounds, and which CI checks gate a merge.
- **Unanswered PRs:** read 2–3 from `open_external_waiting`.

## 6. Profile the project

Fill in what the numbers can't show. For each answer, cite where it came from. Mark the project's own claims as such ("per its README") rather than presenting them as independent fact.

- **What it is and who it's for:** one paragraph on the problem it solves and its intended user. In self mode, reuse `docs/agents/index.md` when it exists; otherwise use the target's README and docs.
- **Alternatives:** start with the project's own comparison pages, then search the web if you can. Pick 2–4 real competitors and compare approach, scope, trade-offs, and recent activity. If you can't search the web, say the comparison rests only on the project's own claims.
- **Maturity and stability:** the latest version and 1.0 status; the stated semver policy; how often it breaks (`breaking_series_first_releases`, tags, CHANGELOG "BREAKING" entries, migration guides); production use (adopters lists, showcase pages, registry downloads).
- **Who's behind it:** a company, one person, or a foundation (`repo.owner` type, email domains); funding (`fundingLinks`, sponsors); any commercial or open-core angle (paid tier, `ee/` directories, several licenses, a copyright-assigning CLA).
- **License:** the main license and whether it allows commercial use; extra license files that cover parts of the code; CLA or DCO (`prs.cla_signals`, `Signed-off-by` counts); and the licenses of direct runtime dependencies. Flag copyleft, source-available, and unknown licenses.
- **Security policy:** the reporting channel; `security_advisories` with their severity and how fast fixes shipped; whether a dependency-update bot runs. What the project executes belongs in `index-codebase`: in self mode, link to `docs/agents/using.md`; in dependency mode, note the install-time lifecycle scripts in the target's manifest.
- **Community:** where discussion happens (`contactLinks`, Discussions, chat links in the README), the code of conduct, and how decisions get made.
- **What's welcome:** `welcome_issues`, the roadmap (pinned issues, milestones), and scope boundaries: what maintainers decline, judging from not-planned issues and the rejected-PR samples.
- **Credit:** whether contributors are credited (contributor files, release notes) and whether `Co-authored-by` is kept on merge.

## 7. Verdict

| Verdict | Typical signals |
| --- | --- |
| **Active** | A stable release in the last ~3 months. External PRs get a maintainer response within ~2 weeks, and a fair share land. Several people merge or commit. |
| **Maintained, slow** | Releases and merges continue, but external PRs and issues wait weeks to months, and the backlog is growing. |
| **Minimal maintenance** | Occasional dependency or security bumps, mostly by one person. Most external PRs go unanswered. |
| **Dormant** | Archived, or no stable release and few or no landed PRs in the window. |

- **Judge relative to scope.** A small, finished library with little activity can be healthy if questions still get answered.
- **Flag separately:**
  - concentration risk: the top merger's share is above ~0.8, or one person makes most of the commits
  - license risk: copyleft or source-available terms, or a CLA that assigns copyright
  - stability risk: still pre-1.0, or a breaking release more often than about twice a year

## 8. Write the report

Write the report to `docs/agents/project-health.md` in self mode, or to the location the user chose in dependency mode. It's a snapshot, so replace it wholesale when it already carries the marker. If the file exists without the marker, ask before touching it.

Links to `index.md`, `using.md`, `contributing.md`, and `areas/` apply in self mode only. In dependency mode, those files describe a different project, so leave the links out.

Start the report with the marker, then follow [references/report-template.md](references/report-template.md):

```markdown
<!-- index-github: snapshot of OWNER/NAME on YYYY-MM-DD, last N days. Numbers go stale; rerun index-github to refresh. -->
```

## 9. Wire up and report

**Dependency mode:** skip the wiring. Don't touch the `## Agent docs` section, because it describes the current project, not the dependency. If the report was saved under `docs/agents/deps/`, say so in chat so the user can decide whether to keep it. Delete the temp clone.

**Self mode:**

Both `index-codebase` and `index-github` link their docs from one shared `## Agent docs` section in `AGENTS.md`. Each skill owns exactly one line in it. Yours links to `docs/agents/project-health.md`, and on every rerun you update its date:

```markdown
## Agent docs

- [docs/agents/project-health.md](docs/agents/project-health.md): maintenance activity, backing, license, alternatives, contribution norms. Snapshot from <YYYY-MM-DD>; rerun index-github for current numbers.
```

- **Find the section.** Create `AGENTS.md` or append the section if missing. If `AGENTS.md` already lists links to other docs, add your line to that list instead.
- **Edit only your line.** Find it by its link target, `docs/agents/project-health.md`, since the wording varies between skill versions. Update or add it, once. Leave everything else untouched, and never add `index-codebase`'s line: its file may not exist yet.
- **Connect `CLAUDE.md`.** If it exists and neither imports nor mentions `AGENTS.md`, add your line to it under `## Agent docs`. If it doesn't exist, create it containing just `@AGENTS.md`.

If `docs/agents/index.md` exists, also link `project-health.md` under its "Further reading" section.

Don't commit. In chat, give:

- the verdict and the risks
- 5–8 key numbers
- the closest alternatives
- the top problem areas
- the caveats
- the path of the report
