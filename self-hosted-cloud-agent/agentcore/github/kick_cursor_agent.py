#!/usr/bin/env python3
"""Start a Cursor Cloud Agent on the AgentCore self-hosted pool.

Triggers:
  - GitHub Project (users/skopp002/projects/2) Status set to In Progress
    for issues whose title starts with 'agent-'
  - Issue labeled 'in-progress'
  - workflow_dispatch with an issue number

After tests, Cursor opens a PR against main (autoCreatePR).
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

GITHUB_API = "https://api.github.com"
GITHUB_GRAPHQL = "https://api.github.com/graphql"
CURSOR_API = "https://api.cursor.com/v1/agents"
KICKOFF_MARKER = "<!-- cursor-cloud-agent-kickoff -->"
TITLE_PREFIX = "agent-"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def github_request(url: str, token: str, payload: dict | None = None, method: str | None = None) -> dict | list:
    data = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kaushalavardhanam-cursor-agent-kickoff",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub {exc.code} {url}: {detail}") from exc


def graphql(token: str, query: str, variables: dict) -> dict:
    body = github_request(GITHUB_GRAPHQL, token, {"query": query, "variables": variables})
    if body.get("errors"):
        raise RuntimeError(f"GraphQL errors: {json.dumps(body['errors'])}")
    return body["data"]


def cursor_create(api_key: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        CURSOR_API,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Cursor API {exc.code}: {detail}") from exc


def already_started(repo: str, issue_number: int, token: str) -> bool:
    comments = github_request(
        f"{GITHUB_API}/repos/{repo}/issues/{issue_number}/comments?per_page=100",
        token,
    )
    if not isinstance(comments, list):
        return False
    return any(KICKOFF_MARKER in (c.get("body") or "") for c in comments)


def fetch_issue(repo: str, number: int, token: str) -> dict:
    return github_request(f"{GITHUB_API}/repos/{repo}/issues/{number}", token)  # type: ignore[return-value]


def start_agent(issue: dict, repo: str, comment_token: str, cursor_key: str, pool: str) -> None:
    number = issue["number"]
    title = issue.get("title") or ""
    if not title.lower().startswith(TITLE_PREFIX):
        print(f"skip #{number}: title does not start with {TITLE_PREFIX!r}")
        return
    if issue.get("pull_request"):
        print(f"skip #{number}: pull request")
        return
    if already_started(repo, number, comment_token):
        print(f"skip #{number}: already kicked off")
        return

    html_url = issue["html_url"]
    body = issue.get("body") or "(no description)"
    branch = f"cursor/{title[:80]}"
    prompt = f"""Implement GitHub issue #{number}: {title}
Issue: {html_url}

{body}

Operating constraints:
- Start from origin/main. Work on a feature branch (suggested name: {branch}). Never commit to main.
- Stay inside this repository. Run the tests that apply to your changes.
- Do not open a pull request until those tests pass, or explain in the PR why they could not be run.
- Open a pull request targeting main when the work is complete.
- Do not commit secrets, credentials, or private recordings.
"""

    repo_url = f"https://github.com/{repo}.git"
    payload = {
        "prompt": {"text": prompt},
        "name": title[:100],
        "env": {"type": "pool", "name": pool},
        "repos": [{"url": repo_url, "startingRef": "main"}],
        "autoCreatePR": True,
    }
    print(f"starting Cursor agent for #{number} on pool {pool}")
    result = cursor_create(cursor_key, payload)
    agent = result.get("agent") or {}
    agent_id = agent.get("id") or "unknown"
    agent_url = agent.get("url") or f"https://cursor.com/agents/{agent_id}"
    comment = (
        f"{KICKOFF_MARKER}\n"
        f"Started self-hosted Cursor Cloud Agent **{agent_id}** on pool `{pool}`.\n\n"
        f"- Watch the run: {agent_url}\n"
        f"- It will open a PR against `main` when tests finish.\n"
    )
    github_request(
        f"{GITHUB_API}/repos/{repo}/issues/{number}/comments",
        comment_token,
        {"body": comment},
    )
    print(f"started {agent_id} -> {agent_url}")


def scan_project(owner: str, number: int, repo: str, project_token: str, comment_token: str, cursor_key: str, pool: str) -> int:
    query = """
    query ($login: String!, $number: Int!, $cursor: String) {
      user(login: $login) {
        projectV2(number: $number) {
          items(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                }
              }
              content {
                __typename
                ... on Issue {
                  number
                  title
                  url
                  repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    }
    """
    started = 0
    cursor = None
    while True:
        data = graphql(project_token, query, {"login": owner, "number": number, "cursor": cursor})
        project = (data.get("user") or {}).get("projectV2")
        if not project:
            raise RuntimeError(f"Project {owner}/{number} not found or token lacks project read access")
        items = project["items"]
        for node in items["nodes"]:
            content = node.get("content") or {}
            if content.get("__typename") != "Issue":
                continue
            if (content.get("repository") or {}).get("nameWithOwner") != repo:
                continue
            status = ""
            for fv in (node.get("fieldValues") or {}).get("nodes") or []:
                field = (fv.get("field") or {}).get("name") or ""
                if normalize(field) == "status":
                    status = fv.get("name") or ""
                    break
            if normalize(status) != "inprogress":
                continue
            issue = fetch_issue(repo, content["number"], comment_token)
            before = already_started(repo, content["number"], comment_token)
            start_agent(issue, repo, comment_token, cursor_key, pool)
            if not before and already_started(repo, content["number"], comment_token):
                started += 1
        if not items["pageInfo"]["hasNextPage"]:
            break
        cursor = items["pageInfo"]["endCursor"]
    return started


def main() -> int:
    repo = env("GITHUB_REPOSITORY")
    cursor_key = env("CURSOR_API_KEY")
    comment_token = env("GITHUB_TOKEN")
    project_token = env("GH_PROJECT_TOKEN") or comment_token
    pool = env("CURSOR_POOL_NAME", "agentcore-platform-agents")
    project_owner = env("PROJECT_OWNER", "skopp002")
    project_number = int(env("PROJECT_NUMBER", "2") or "2")
    event = env("GITHUB_EVENT_NAME") or env("EVENT_NAME")

    if not repo or not cursor_key or not comment_token:
        print("CURSOR_API_KEY, GITHUB_TOKEN, and GITHUB_REPOSITORY are required", file=sys.stderr)
        return 1

    if event == "issues":
        label = env("LABEL_NAME")
        issue_number = env("ISSUE_NUMBER")
        if normalize(label) not in {"inprogress", "agent", "agentrun"}:
            print(f"ignore label {label!r}")
            return 0
        issue = fetch_issue(repo, int(issue_number), comment_token)
        start_agent(issue, repo, comment_token, cursor_key, pool)
        return 0

    if event == "workflow_dispatch" and env("ISSUE_NUMBER"):
        issue = fetch_issue(repo, int(env("ISSUE_NUMBER")), comment_token)
        start_agent(issue, repo, comment_token, cursor_key, pool)
        return 0

    print(f"scanning project {project_owner}/{project_number} for In Progress {TITLE_PREFIX}* issues")
    started = scan_project(project_owner, project_number, repo, project_token, comment_token, cursor_key, pool)
    print(f"started {started} agent(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
