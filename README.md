# ohmybug CLI

Review the changes in a git repository with the [OhMyBug](https://ohmybug.ai) bug hunt from any CI system (GitLab CI, Bitbucket Pipelines, Jenkins) or from your shell. The repository can be hosted anywhere: the CLI sends the diff and a few related files itself.

One file, no dependencies, Node.js 18 or newer.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/explyt/ohmybug-cli/main/install.sh | sh
```

Or download [`ohmybug.mjs`](ohmybug.mjs) and run it with `node ohmybug.mjs`.

## Use

Create an API key at [ohmybug.ai/me](https://ohmybug.ai/me) and put it in `OHMYBUG_API_KEY`. Then, in the repository folder:

```sh
ohmybug                  # review <base>...HEAD: the commits of this branch
ohmybug --base develop   # the same against another base
ohmybug --uncommitted    # review the working tree against HEAD, untracked files included
```

The base is `--base`, else `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (GitLab merge request pipelines), else `origin/main`. The CI clone must contain the base: fetch it, or clone with enough depth.

The CLI prints each finding (severity, file:line, title, failure scenario) and a link to the full report.

| Exit code | Meaning |
|---|---|
| 0 | no medium or worse bug (lows are printed, and do not fail the job) |
| 1 | at least one medium or worse bug |
| 2 | the review could not run: no key, a refused key, network, a failed review, or a run cut short with nothing found |

| Variable | Default | |
|---|---|---|
| `OHMYBUG_API_KEY` | required | your key |
| `OHMYBUG_TIMEOUT_S` | `1800` | how long to wait for the review |
| `OHMYBUG_URL` | `https://mcp.ohmybug.ai` | the service |

## Billing

A key on **CI billing** (the key setting on [ohmybug.ai/me](https://ohmybug.ai/me)) pays per hunt with no confirm step: $2 for a fast hunt and $5 for a deep one ($10 on a large repository), only when the result holds a medium or worse bug. A clean or failed hunt is free. The run prints what it was charged.

## GitLab CI

```yaml
ohmybug:
  image: node:22
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - curl -fsSL https://raw.githubusercontent.com/explyt/ohmybug-cli/main/install.sh | sh
    - ohmybug
```

Set `OHMYBUG_API_KEY` as a masked CI/CD variable.

## Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          image: node:22
          script:
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - curl -fsSL https://raw.githubusercontent.com/explyt/ohmybug-cli/main/install.sh | sh
            - ohmybug --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH"
```

## What is sent

The diff, the list of file paths at the reviewed head, and up to 30 related files from your checkout (the changed files, the project manifests, and files that mention a changed module). During the review the reviewers may ask for more files by path; the CLI answers from your checkout. Nothing outside the repository folder is read, and nothing under `.git`.

## Develop

```sh
node --test test/*.test.mjs
```
