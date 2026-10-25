# Git_PR AI

An agent that reads a GitHub issue, explores the repository with tools, edits code, runs the tests, and opens a **draft pull request** with the proposed fix.

**Stack:** Node 20+, Express, Octokit, simple-git, Anthropic SDK (tool use).

## How it works

```
issue label / POST /api/fix
        │
        ▼
   in-memory queue ──► pipeline
                         1. fetch issue + comments (Octokit)
                         2. shallow clone, create branch ai-fix/issue-N-xxxx
                         3. agent loop (Claude + tools):
                              list_files · search_code · read_file
                              replace_in_file · write_file · run_tests · finish
                         4. re-run tests as final validation
                         5. stage ONLY files the agent touched, commit, push
                         6. open DRAFT PR ("Fixes #N"), label ai-generated, comment on issue
```

If the agent can't fix it (`cannot_fix`) or tests still fail, it comments its analysis on the issue instead of opening a bad PR.

## Setup

```bash
npm install
cp .env.example .env     # fill in the values
npm start                # http://localhost:3000
npm test                 # tool-layer tests (no network or API keys needed)
```

**GitHub token:** create a fine-grained personal access token limited to your target repos with *Contents*, *Pull requests*, and *Issues* set to Read & write. Put the repos in `ALLOWED_REPOS` (e.g. `you/app,you/lib`).

## Using it

**Dashboard:** open `http://localhost:3000`, enter your `API_KEY`, a repo and an issue number.

**API:**
```bash
curl -X POST localhost:3000/api/fix \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"repo":"you/app","issueNumber":12}'

curl -H "x-api-key: $API_KEY" localhost:3000/api/jobs        # list
curl -H "x-api-key: $API_KEY" localhost:3000/api/jobs/<id>   # status + logs
```

**Webhook (auto-trigger):** in the repo settings add a webhook to `https://<your-host>/webhooks/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, event **Issues**. Adding the `ai-fix` label to an issue then starts a run. For local dev, expose the port with ngrok or cloudflared.

## Fork mode

Set `FORK_MODE` to control where the fix branch goes:

- `auto` (default): push directly if your token has write access, otherwise fork the repo into your account and open the PR from the fork.
- `always`: always use a fork, so bot branches never touch the upstream repo.
- `never`: push directly only; the job fails if there is no write access.

Forking needs a token that can create forks. If a fine-grained token is rejected when forking, use a classic token with the `public_repo` scope (or `repo` for private repos). `ALLOWED_REPOS` still applies, so the agent only works on repos you list.

## Failproof AI observability (optional)

Runs can be traced with the [Failproof AI](https://docs.befailproof.ai) TypeScript SDK (`@failproofai/sdk`). Each fix job becomes one Failproof **session** whose ID is the job ID, so a trace on the dashboard and a job in this app share an identifier.

| Pipeline step | Failproof event |
| --- | --- |
| Agent run (clone → PR) | `agent_start` / `agent_end` (outcome set from the job result) |
| Each Claude call | `model_request` / `model_response` with token counts |
| Each agent tool call | `tool_use` / `tool_result` (tool errors recorded) |
| Final tests, opening the PR | `hook_triggered` / `hook_completed` |

Outcome mapping: `pr_opened` is `success`; `cannot_fix` is `rejected`; `tests_failed`, `no_changes` and `incomplete` are `failed`. An exception is recorded as an `error` event and a failed run.

**Setup**

1. In the Failproof dashboard create a key with the `events:add` permission (Admin → Keys).
2. On the machine running this app: `npm i -g failproofai`, then `failproofai config` and `failproofai config --status`. The SDK only writes events to a local spool; the Failproof daemon ships them.
3. Set `FAILPROOFAI_ENABLED=true` (and `FAILPROOFAI_ENVIRONMENT=production`, no commas) in `.env`, then restart.
4. Run a fix, then check the dashboard under Observe → Sessions, or `fp sessions --since 1h --session-id <job id>`.

By default only metadata is recorded: models, token counts, tool names, and inputs and outputs clipped to a few hundred characters. Set `FAILPROOFAI_CAPTURE_CONTENT=true` to also record prompts, model replies and full tool I/O, which includes your repo's source code. The SDK redacts secret-shaped strings before writing.

This is observability only. Blocking or correcting agent actions in flight (Failproof's policy engine) works with supported agent harnesses; for a custom runtime like this one, Failproof asks you to contact them to map the hooks.

## PR guardrails (Failproof AI)

Rules live in one file, `src/guardrails/rules.js`, and are applied in two places:

| Rule | Where it runs |
| --- | --- |
| Never modify `.env*`, `.git/`, `.github/` | Failproof policy `.failproofai/policies/pr-guardrails.mjs` (PreToolUse), the tool layer, a gate before `git add`, and a re-check of the real PR file list on GitHub |
| Only work on issues labeled `TRIGGER_LABEL` (default `ai-fix`) | Gate at the start of every job |
| Opened PR must carry `ai-generated` | Post-open verification; a PR that fails any check is closed with a comment |

Every gate is traced as a Failproof `hook_triggered` / `hook_completed` pair named `guardrail:<rule>`, so decisions show up in the session next to the tool calls.

Failproof enforces policies at a hook in the agent runtime. For this custom runtime that hook still has to be mapped by Failproof (support@befailproof.ai); until then the pipeline gates above are what actually enforce. Test a policy with `fp policies test .failproofai/policies/pr-guardrails.mjs`.

## Safety design

- Repo allowlist (`ALLOWED_REPOS`); API protected by key; webhook HMAC verified in constant time.
- Agent tools are confined to the clone: `..` traversal and symlink escapes rejected; writes to `.git/`, `.env*`, and `.github/` blocked.
- Test/install commands run with a **minimal environment**, so repo code cannot read your tokens. Dependencies install with `--ignore-scripts`.
- Set `SANDBOX_DOCKER_IMAGE` (e.g. `node:20-bookworm`) to run installs and tests in a container with memory, CPU, and PID limits. Do this for any repo you don't fully trust.
- Issue text is treated as untrusted (prompt-injection guard in the system prompt).
- PRs are always drafts; limits on steps (`MAX_STEPS`) and tokens (`MAX_TOTAL_TOKENS`) bound the cost per run.
- Secrets are redacted from logs and API responses.

## Known limitations and next steps

- Queue and job history are in memory (lost on restart). Swap `src/queue.js` for BullMQ + Redis for persistence and multiple workers.
- Context is built by the agent via search, not an index. For very large repos, add embeddings or tree-sitter symbol search as another tool.
- Replace the PAT with a **GitHub App** for per-installation, short-lived tokens.
- Ideas: respond to PR review comments with follow-up commits, add a lint tool, add per-repo config (`.git-pr-ai.json`) for test commands.

## Layout

```
src/server.js            Express: webhook, API, dashboard
src/queue.js             in-memory job queue
src/config.js            env config + secret redaction
src/prompts.js           system and task prompts
src/services/pipeline.js orchestration: clone → agent → validate → PR
src/services/agent.js    tool-use loop
src/services/tools.js    sandboxed tools exposed to the model
src/services/sandbox.js  install/test runner (host or Docker)
src/services/github.js   Octokit wrappers
src/services/repo.js     clone, extra remotes, workspace cleanup
src/services/push-target.js  direct-push vs fork decision
src/telemetry.js         optional Failproof AI tracing (no-op when disabled)
public/index.html        minimal dashboard
test/tools.test.js       tests for the tool layer
```
