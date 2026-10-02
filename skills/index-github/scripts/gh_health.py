#!/usr/bin/env python3
"""Fetch a GitHub repo's recent issues, PRs, and releases with `gh`, and print health stats as JSON.

Read-only. Needs an authenticated `gh`. Raw data is saved to --out for follow-up queries.
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAINTAINER = {"OWNER", "MEMBER", "COLLABORATOR"}
BUG_LABEL = re.compile(r"bug|defect|regression|crash", re.I)
TRANSIENT = re.compile(r"\b50[234]\b|timeout|timed out|rate limit|abuse|something went wrong", re.I)
LOCKFILE = re.compile(r"(^|/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock)$")
WELCOME_LABEL = re.compile(r"good.first|first.timer|beginner|starter|help.wanted|contributions.welcome", re.I)
CLA = re.compile(r"\bcla\b|easycla|cla.?assistant|cla.?bot|\bdco\b", re.I)
FIX_TITLE = re.compile(r"^(fix|bugfix|hotfix)\b|^fix(\(.+?\))?!?:", re.I)

ACTOR = "author { __typename login }"
COMMENTS = f"comments(first: 30) {{ totalCount nodes {{ {ACTOR} authorAssociation createdAt }} }}"
LABELS = "labels(first: 20) { nodes { name } }"

PR_FIELDS = f"""
number title url state isDraft createdAt mergedAt closedAt authorAssociation {ACTOR}
mergedBy {{ __typename login }} additions deletions {LABELS} {COMMENTS}
reviews(first: 30) {{ nodes {{ {ACTOR} authorAssociation submittedAt state }} }}
files(first: 100) {{ nodes {{ path }} }}
closingIssuesReferences(first: 10) {{ nodes {{ number {LABELS} }} }}
timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {{
  nodes {{ ... on ClosedEvent {{ createdAt actor {{ __typename login }} closer {{ __typename }} }} }}
}}
"""

ISSUE_FIELDS = f"""
number title url state stateReason createdAt closedAt authorAssociation {ACTOR}
reactions {{ totalCount }} {LABELS} {COMMENTS}
"""


MIN_REMAINING = 300  # stop paginating before the user's hourly GraphQL quota runs out
API = {"calls": 0, "points": 0, "remaining": None, "stopped_low_quota": False}


class Transient(Exception):
    pass


def gh_graphql(query, attempts=4, **variables):
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is not None:
            args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    for attempt in range(attempts):
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode == 0:
            data = json.loads(proc.stdout)
            if not data.get("errors"):
                API["calls"] += 1
                rl = data["data"].get("rateLimit")
                if rl:
                    API["points"] += rl["cost"]
                    API["remaining"] = rl["remaining"]
                return data["data"]
            err = json.dumps(data["errors"])[:500]
        else:
            err = proc.stderr.strip()[:500]
        if not TRANSIENT.search(err):
            sys.exit(f"gh api failed: {err}")
        print(f"gh api failed (attempt {attempt + 1}/{attempts}): {err}", file=sys.stderr)
        if attempt + 1 < attempts:
            time.sleep(2 ** attempt * 2)
    raise Transient(err)


def paginate(query, conn, owner, name, page_size):
    """Yield pages; on repeated 502s/timeouts halve the page size, and grow it back after 5 clean pages."""
    cursor, n, streak = None, page_size, 0
    while True:
        if API["remaining"] is not None and API["remaining"] < MIN_REMAINING:
            print(f"  {conn}: stopping, only {API['remaining']} GraphQL points left this hour", file=sys.stderr)
            API["stopped_low_quota"] = True
            return
        try:
            page = gh_graphql(query, attempts=2, owner=owner, name=name, cursor=cursor, n=n)["repository"][conn]
        except Transient as e:
            if n == 1:
                sys.exit(f"giving up: {e}")
            n, streak = max(1, n // 2), 0
            print(f"  {conn}: shrinking page size to {n}", file=sys.stderr)
            continue
        yield page
        if not page["pageInfo"]["hasNextPage"]:
            return
        cursor, streak = page["pageInfo"]["endCursor"], streak + 1
        if streak >= 5 and n < page_size:
            n, streak = min(page_size, n * 2), 0


def fetch_recent(owner, name, conn, fields, since, limit, page_size):
    """Newest-first by creation date; stop at `since` or `limit`."""
    query = f"""
    query($owner: String!, $name: String!, $cursor: String, $n: Int!) {{
      rateLimit {{ cost remaining }}
      repository(owner: $owner, name: $name) {{
        {conn}(first: $n, after: $cursor, orderBy: {{field: CREATED_AT, direction: DESC}}) {{
          totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {fields} }}
        }}
      }}
    }}"""
    items = []
    for page in paginate(query, conn, owner, name, page_size):
        for node in page["nodes"]:
            if parse(node["createdAt"]) < since:
                return items, False
            items.append(node)
            if len(items) >= limit:
                return items, True
        print(f"  {conn}: {len(items)}", file=sys.stderr)
    return items, API["stopped_low_quota"]


def fetch_meta(owner, name):
    query = """
    query($owner: String!, $name: String!) {
      rateLimit { cost remaining }
      repository(owner: $owner, name: $name) {
        nameWithOwner description url stargazerCount forkCount isArchived isFork
        createdAt pushedAt homepageUrl licenseInfo { spdxId name } defaultBranchRef { name }
        parent { nameWithOwner } owner { __typename login }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        fundingLinks { platform url }
        codeOfConduct { name url }
        isSecurityPolicyEnabled securityPolicyUrl
        hasDiscussionsEnabled discussions { totalCount } hasWikiEnabled
        contactLinks { name url about }
        pinnedIssues(first: 3) { nodes { issue { number title url } } }
        openIssues: issues(states: OPEN) { totalCount }
        openPRs: pullRequests(states: OPEN) { totalCount }
        releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
          totalCount nodes { tagName publishedAt isPrerelease }
        }
      }
    }"""
    try:
        return gh_graphql(query, owner=owner, name=name)["repository"]
    except Transient as e:
        sys.exit(f"giving up: {e}")


def fetch_advisories(repo):
    """Published GitHub security advisories; None when the endpoint isn't readable."""
    proc = subprocess.run(
        ["gh", "api", f"repos/{repo}/security-advisories?state=published&per_page=100"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    return [
        {"id": a["ghsa_id"], "severity": a["severity"], "summary": a["summary"], "published": a["published_at"]}
        for a in json.loads(proc.stdout)
    ]


def fetch_open(owner, name, conn, fields, limit):
    """Open items oldest-first, light fields only, for backlog age counts."""
    query = f"""
    query($owner: String!, $name: String!, $cursor: String, $n: Int!) {{
      rateLimit {{ cost remaining }}
      repository(owner: $owner, name: $name) {{
        {conn}(first: $n, after: $cursor, states: OPEN, orderBy: {{field: CREATED_AT, direction: ASC}}) {{
          pageInfo {{ hasNextPage endCursor }} nodes {{ {fields} }}
        }}
      }}
    }}"""
    items = []
    for page in paginate(query, conn, owner, name, 100):
        items += page["nodes"]
        if len(items) >= limit:
            return items[:limit], True
    return items, API["stopped_low_quota"]


def backlog_stats(open_issues, open_prs, now):
    def older(items, truncated, n_days):
        cutoff = now - timedelta(days=n_days)
        count = sum(1 for i in items if parse(i["createdAt"]) < cutoff)
        # Oldest-first fetch: a truncated list undercounts buckets whose cutoff is past its newest item.
        exact = not truncated or not items or parse(items[-1]["createdAt"]) >= cutoff
        return count if exact else f">={count}"

    def count(items, truncated, pred):
        n = sum(1 for i in items if pred(i))
        return f">={n}" if truncated else n

    def stale(items, truncated, n_days):
        return count(items, truncated, lambda i: parse(i["updatedAt"]) < now - timedelta(days=n_days))

    (issues, issues_truncated), (prs, prs_truncated) = open_issues, open_prs
    human_prs = [p for p in prs if not is_bot(p["author"])]
    return {
        "open_issues_fetched": len(issues),
        "open_prs_fetched": len(prs),
        # When truncated, labels and welcome_issues cover only the oldest open items.
        "open_issues_truncated": issues_truncated,
        "open_prs_truncated": prs_truncated,
        "issues_open_older_90d": older(issues, issues_truncated, 90),
        "issues_open_older_1y": older(issues, issues_truncated, 365),
        "issues_open_older_2y": older(issues, issues_truncated, 730),
        "issues_open_not_updated_1y": stale(issues, issues_truncated, 365),
        "issues_open_no_label": count(issues, issues_truncated, lambda i: not i["labels"]["totalCount"]),
        "issues_open_no_comments": count(issues, issues_truncated, lambda i: not i["comments"]["totalCount"]),
        "open_issue_labels": Counter(l for i in issues for l in label_names(i)).most_common(20),
        "welcome_issues": [
            brief(i, labels=label_names(i)) for i in reversed(issues)
            if any(WELCOME_LABEL.search(l) for l in label_names(i))
        ][:15],
        "prs_open_bot": count(prs, prs_truncated, lambda p: is_bot(p["author"])),
        "prs_open_draft": count(human_prs, prs_truncated, lambda p: p["isDraft"]),
        "prs_open_older_30d": older(human_prs, prs_truncated, 30),
        "prs_open_older_90d": older(human_prs, prs_truncated, 90),
        "prs_open_older_1y": older(human_prs, prs_truncated, 365),
        "prs_open_no_review": count(human_prs, prs_truncated, lambda p: not p["isDraft"] and not p["reviews"]["totalCount"]),
        "prs_open_not_updated_90d": stale(human_prs, prs_truncated, 90),
    }


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def days(a, b):
    return round((parse(b) - parse(a)).total_seconds() / 86400, 2)


IGNORED = set()  # extra bot-like logins from --ignore-users
BOT_LOGIN = re.compile(r"\[bot\]$|[-_]bot$|^bot[-_]", re.I)


def is_bot(actor):
    """A missing actor is a deleted ("ghost") account, not a bot."""
    if not actor:
        return False
    return actor["__typename"] == "Bot" or bool(BOT_LOGIN.search(actor["login"])) or actor["login"] in IGNORED


def landed_at(pr):
    """Merged on GitHub, or closed by a commit (repos that land PRs outside GitHub)."""
    if pr["mergedAt"]:
        return pr["mergedAt"]
    events = pr["timelineItems"]["nodes"]
    if events and events[0].get("closer") and events[0]["closer"]["__typename"] == "Commit":
        return events[0]["createdAt"]
    return None


def lander(pr):
    if pr["mergedAt"]:
        return pr["mergedBy"]
    return pr["timelineItems"]["nodes"][0].get("actor")


def login(actor):
    return actor["login"] if actor else "ghost"


def dist(values):
    if not values:
        return None
    values = sorted(values)
    q = lambda p: values[min(len(values) - 1, int(p * len(values)))]
    return {"n": len(values), "median": round(statistics.median(values), 2), "p75": q(0.75), "p90": q(0.9)}


def first_response(item, maintainers_only=False):
    """Days to the first comment or review by someone other than the author or a bot."""
    author = login(item["author"])
    events = [(c["createdAt"], c) for c in item["comments"]["nodes"]]
    events += [(r["submittedAt"], r) for r in item.get("reviews", {}).get("nodes", []) if r["submittedAt"]]
    for ts, e in sorted(events, key=lambda x: x[0]):
        if is_bot(e["author"]) or login(e["author"]) == author:
            continue
        if maintainers_only and e["authorAssociation"] not in MAINTAINER:
            continue
        return days(item["createdAt"], ts)
    return None


def label_names(item):
    return [l["name"] for l in item["labels"]["nodes"]]


def is_fix_pr(pr):
    if any(BUG_LABEL.search(l) for l in label_names(pr)):
        return True
    if any(BUG_LABEL.search(l) for i in pr["closingIssuesReferences"]["nodes"] for l in label_names(i)):
        return True
    return bool(FIX_TITLE.search(pr["title"]))


def brief(item, **extra):
    return {"number": item["number"], "title": item["title"], "url": item["url"], **extra}


def pr_stats(prs, now, depth):
    groups = {"maintainer": [], "external": [], "bot": []}
    for pr in prs:
        if is_bot(pr["author"]):
            groups["bot"].append(pr)
        elif pr["authorAssociation"] in MAINTAINER:
            groups["maintainer"].append(pr)
        else:
            groups["external"].append(pr)

    def summarize(items):
        landed = [p for p in items if landed_at(p)]
        rejected = [p for p in items if p["state"] == "CLOSED" and not landed_at(p)]
        open_ = [p for p in items if p["state"] == "OPEN"]
        responses = [first_response(p, maintainers_only=True) for p in items]
        no_response_open = [
            p for p, r in zip(items, responses)
            if r is None and p["state"] == "OPEN" and days(p["createdAt"], now.isoformat()) > 14
        ]
        return {
            "opened": len(items),
            "landed": len(landed),
            "landed_via_commit_close": sum(1 for p in landed if not p["mergedAt"]),
            "closed_unmerged": len(rejected),
            "open": len(open_),
            "days_to_land": dist([days(p["createdAt"], landed_at(p)) for p in landed]),
            "days_to_first_maintainer_response": dist([r for r in responses if r is not None]),
            "days_to_first_human_response": dist([r for r in map(first_response, items) if r is not None]),
            "open_no_maintainer_response_over_14d": len(no_response_open),
            "self_merged": sum(1 for p in landed if lander(p) and login(lander(p)) == login(p["author"])),
        }

    ext = groups["external"]
    landed_ext = sorted((p for p in ext if landed_at(p)), key=lambda p: -days(p["createdAt"], landed_at(p)))
    hotspots = {}
    for pr in prs:
        if not landed_at(pr) or is_bot(pr["author"]):
            continue
        fix = is_fix_pr(pr)
        prefixes = {
            "/".join(f["path"].split("/")[:depth]) for f in pr["files"]["nodes"] if not LOCKFILE.search(f["path"])
        }
        for prefix in prefixes:
            h = hotspots.setdefault(prefix, {"path": prefix, "landed_prs": 0, "fix_prs": 0})
            h["landed_prs"] += 1
            h["fix_prs"] += fix

    return {
        "by_origin": {k: summarize(v) for k, v in groups.items()},
        "reverts": [brief(p) for p in prs if p["title"].lower().startswith("revert")],
        "top_labels": Counter(l for p in prs for l in label_names(p)).most_common(20),
        "cla_signals": {
            "labels": Counter(l for p in prs for l in label_names(p) if CLA.search(l)).most_common(5),
            "commenters": Counter(
                login(c["author"]) for p in prs for c in p["comments"]["nodes"] if CLA.search(login(c["author"]))
            ).most_common(5),
        },
        "hotspots": sorted(hotspots.values(), key=lambda h: (-h["fix_prs"], -h["landed_prs"]))[:30],
        "samples": {
            "slowest_landed_external": [
                brief(p, days=days(p["createdAt"], landed_at(p))) for p in landed_ext[:8]
            ],
            "closed_unmerged_external": [
                brief(p, author=login(p["author"])) for p in ext if p["state"] == "CLOSED" and not landed_at(p)
            ][:10],
            "open_external_waiting": [
                brief(p, age_days=days(p["createdAt"], now.isoformat()))
                for p in ext if p["state"] == "OPEN" and not p["isDraft"] and first_response(p, True) is None
            ][:10],
        },
    }


def people_stats(prs, issues):
    landers = [lander(p) for p in prs if landed_at(p)]
    mergers = Counter(login(l) for l in landers if l and not is_bot(l))
    reviewers = Counter(
        login(r["author"]) for p in prs for r in p["reviews"]["nodes"]
        if not is_bot(r["author"]) and login(r["author"]) != login(p["author"])
    )
    responders = Counter(
        login(c["author"]) for i in issues for c in i["comments"]["nodes"]
        if c["authorAssociation"] in MAINTAINER and not is_bot(c["author"])
    )
    authors = Counter(login(p["author"]) for p in prs if not is_bot(p["author"]))
    total_merges = sum(mergers.values())
    return {
        "mergers": mergers.most_common(10),
        # Landed by a bot (merge queue, internal sync): get the real maintainers from git history.
        "landed_by_bot": sum(1 for l in landers if is_bot(l)),
        "top_merger_share": round(mergers.most_common(1)[0][1] / total_merges, 2) if total_merges else None,
        "top2_merger_share": round(sum(n for _, n in mergers.most_common(2)) / total_merges, 2) if total_merges else None,
        "reviewers": reviewers.most_common(10),
        "maintainer_issue_responders": responders.most_common(10),
        "pr_authors": authors.most_common(10),
        "distinct_pr_authors": len(authors),
    }


def issue_stats(issues, now):
    human = [i for i in issues if not is_bot(i["author"])]
    closed = [i for i in human if i["state"] == "CLOSED"]
    responses = [first_response(i, maintainers_only=True) for i in human]
    open_ = [i for i in human if i["state"] == "OPEN"]
    labels = Counter(l for i in human for l in label_names(i))
    bugs = [i for i in human if any(BUG_LABEL.search(l) for l in label_names(i))]
    pool = bugs if len(bugs) >= 20 else human
    return {
        "opened": len(human),
        "closed": len(closed),
        "closed_completed": sum(1 for i in closed if i["stateReason"] == "COMPLETED"),
        "closed_not_planned": sum(1 for i in closed if i["stateReason"] == "NOT_PLANNED"),
        "open": len(open_),
        "days_to_close": dist([days(i["createdAt"], i["closedAt"]) for i in closed]),
        "days_to_first_maintainer_response": dist([r for r in responses if r is not None]),
        "days_to_first_human_response": dist([r for r in map(first_response, human) if r is not None]),
        "no_maintainer_response": sum(1 for r in responses if r is None),
        "open_no_maintainer_response_over_14d": sum(
            1 for i, r in zip(human, responses)
            if r is None and i["state"] == "OPEN" and days(i["createdAt"], now.isoformat()) > 14
        ),
        "top_labels": labels.most_common(25),
        "bug_labeled": len(bugs),
        "most_reacted_open": [
            brief(i, reactions=i["reactions"]["totalCount"], comments=i["comments"]["totalCount"])
            for i in sorted(open_, key=lambda i: -i["reactions"]["totalCount"])[:10]
        ],
        "titles_for_clustering": {
            "source": "bug-labeled" if pool is bugs else "all",
            "items": [
                {"number": i["number"], "title": i["title"], "state": i["state"], "labels": label_names(i)}
                for i in pool[:200]
            ],
        },
    }


SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def version(release):
    m = SEMVER.search(release["tagName"])
    return tuple(map(int, m.groups())) if m else None


def semver_stats(stable):
    """Breaking-release history from release tags: each major, or each minor while on 0.x."""
    firsts = {}
    for r in stable:  # newest first, so the last write per series is its earliest release
        m = SEMVER.search(r["tagName"])
        if m:
            major, minor = int(m.group(1)), int(m.group(2))
            firsts[(major, minor if major == 0 else 0)] = r
    if not firsts:
        return {"semver_tags": False}
    latest = max(firsts)
    return {
        "semver_tags": True,
        "latest_major": latest[0],
        "reached_1_0": latest[0] >= 1,
        # Earliest series may be cut off when `fetched` < `total`; check git tags for full history.
        "breaking_series_first_releases": [
            {"series": f"{k[0]}.{k[1]}" if k[0] == 0 else f"{k[0]}.x", "tag": v["tagName"], "published": v["publishedAt"][:10]}
            for k, v in sorted(firsts.items())
        ],
    }


def release_stats(meta, since):
    releases = [r for r in meta["releases"]["nodes"] if r["publishedAt"]]
    stable = [r for r in releases if not r["isPrerelease"]]
    in_window = [r for r in stable if parse(r["publishedAt"]) >= since]
    gaps = [days(b["publishedAt"], a["publishedAt"]) for a, b in zip(stable, stable[1:])]
    versioned = [r for r in stable if version(r)]
    return {
        "total": meta["releases"]["totalCount"],
        "stable_in_window": len(in_window),
        # Highest version, so a backport cut after a newer major doesn't count as latest.
        "latest_stable": max(versioned, key=version) if versioned else (stable[0] if stable else None),
        "newest_stable": stable[0] if stable else None,
        "latest_any": releases[0] if releases else None,
        "days_between_stable": dist(gaps[:20]),
        "fetched": len(releases),
        **semver_stats(stable),
        "note": None if releases else "No GitHub releases; check git tags or the package registry.",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="OWNER/NAME")
    ap.add_argument("--days", type=int, default=365, help="look-back window (default 365)")
    ap.add_argument("--max", type=int, default=1000, help="max issues and max PRs to fetch (default 1000)")
    ap.add_argument("--depth", type=int, default=2, help="path depth for hotspots (default 2)")
    ap.add_argument("--max-open", type=int, default=5000, help="max open issues and max open PRs for backlog counts")
    ap.add_argument("--ignore-users", default="", help="comma-separated bot-like logins to treat as bots")
    ap.add_argument("--out", help="directory for raw JSON")
    args = ap.parse_args()

    owner, name = args.repo.split("/", 1)
    IGNORED.update(u.strip() for u in args.ignore_users.split(",") if u.strip())
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)

    print("fetching repo metadata…", file=sys.stderr)
    meta = fetch_meta(owner, name)
    print("fetching PRs…", file=sys.stderr)
    prs, prs_truncated = fetch_recent(owner, name, "pullRequests", PR_FIELDS, since, args.max, 25)
    print("fetching issues…", file=sys.stderr)
    issues, issues_truncated = fetch_recent(owner, name, "issues", ISSUE_FIELDS, since, args.max, 50)
    print("fetching open items for backlog…", file=sys.stderr)
    open_issues = fetch_open(
        owner, name, "issues",
        "number title url createdAt updatedAt labels(first: 10) { totalCount nodes { name } } comments { totalCount }",
        args.max_open,
    )
    open_prs = fetch_open(owner, name, "pullRequests", f"createdAt updatedAt isDraft {ACTOR} reviews {{ totalCount }}", args.max_open)
    backlog = backlog_stats(open_issues, open_prs, now)

    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        for fname, data in {"meta.json": meta, "prs.json": prs, "issues.json": issues}.items():
            (out / fname).write_text(json.dumps(data, indent=1))

    oldest = lambda items: items[-1]["createdAt"] if items else None
    summary = {
        "repo": {k: v for k, v in meta.items() if k not in ("releases",)},
        "generated_at": now.isoformat(timespec="seconds"),
        "window": {
            "days": args.days,
            "since": since.date().isoformat(),
            # When truncated, stats cover only the newest --max items, back to this date.
            "prs": {"fetched": len(prs), "truncated": prs_truncated, "oldest": oldest(prs)},
            "issues": {"fetched": len(issues), "truncated": issues_truncated, "oldest": oldest(issues)},
        },
        "releases": release_stats(meta, since),
        "people": people_stats(prs, issues),
        "prs": pr_stats(prs, now, args.depth),
        "issues": issue_stats(issues, now),
        "backlog": backlog,
        "security_advisories": fetch_advisories(args.repo),
        "api": API,
    }
    json.dump(summary, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
