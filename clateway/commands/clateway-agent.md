---
description: "Work on a Clateway AI agent as a folder: pull it, change its instructions, scripts and files here, test it in a real Clateway sandbox and publish it. Usage: '/clateway-agent pull Ledger Clerk', then diff | test | push -m \"…\" | publish -m \"…\" | log | rollback <n> in that folder."
---

## Work on a Clateway agent as a folder

The arguments are a subcommand and its options. You work on an agent the signed-in person may edit,
through the `clateway` MCP server (tools `agents_workspace_*`). It needs a sign-in with a Clateway
account (OAuth), not an API key, and the company must have switched these tools on under Manage
Company → Integrations → AI agent access → Tools. When a tool is missing or refused, say what the
answer says (`meta_whoami` lists how to enable it) and stop.

The folder is the whole agent:

| File | What it is |
| --- | --- |
| `agent.yaml` | role, mission, persona, skills, actions, custom skills, sandbox settings |
| `instructions.md` | the prompt |
| `evals.yaml` | test cases (task, must_include, must_not_include, min_findings, expect_actions, expect_files) |
| `scripts/…` | code, copied to `/workspace/scripts` in the agent's sandbox |
| `files/…` and other paths | data, templates, fonts, copied to `/workspace/<path>` |
| `.clateway-agent.json` | the agent id and the revision the folder came from; never edit it by hand |

Nothing changes what the agent runs until **publish**. Every change goes into the person's own draft
(the same draft as the Files tab and VS Code on clateway.ai).

The helper script is `"${CLAUDE_PLUGIN_ROOT}/scripts/agent-folder.mjs"` (Node 20+).

### pull <agent> [folder]

1. Call `agents_workspace_pull` with `agent` = the name or id given.
2. Save the tool's answer (the JSON with `files`) to a temporary file, e.g. `/tmp/clateway-pull.json`.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-folder.mjs" write /tmp/clateway-pull.json [folder]`
   (default folder: the agent's name). Use `--force` only when the person asks to write over a folder.
4. Tell the person the folder, the revision it came from and whether it is editable (`editable`).

### diff

Read `.clateway-agent.json` for the agent id. If the folder changed since the pull, first say so: the
diff shows the **draft on Clateway**, not unpushed local changes (run `read` and compare with the
pull when the person wants local changes). Call `agents_workspace_diff` and show per file what
changed, compactly.

### push [-m "message"]

1. In the folder run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-folder.mjs" read . --out /tmp/clateway-push.json`.
2. Call `agents_workspace_push` with the `agent`, `base_revision_id` and `files` from that file. With
   `--dry-run`, pass `dry_run: true`.
3. On success run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-folder.mjs" set-base . <draft id> <draft number>`
   with the draft from the answer, and report added / changed / removed and anything `skipped`.
4. Refused with code `stale`: someone published, or the draft changed on clateway.ai, after the pull.
   Do not retry. Tell the person, offer to pull into a new folder and carry their changes over.
5. Problems in `agent.yaml` or `evals.yaml` come back with file and line: fix them and push again.

The message given with `-m` is used at publish; keep it for then.

### test [case numbers]

Call `agents_workspace_test` (optionally `cases`, 0-based). Then poll `agents_get_skill_test` with
the `run_ids` every 20-30 seconds until `done`. Report per case passed or not, and for failures the
last steps (commands, errors, missing programs or files). Offer to fix the folder, push and test again.

### publish -m "message"

Push first when the folder has unpushed changes. Call `agents_workspace_publish` with the `message` and
the `test_run_ids` of the last passing test. When it answers that the draft is not tested or did not
pass, ask the person whether to test first or to publish anyway; only with their explicit reason
pass `override_reason`. Report the new revision number.

### log

Call `agents_workspace_log` and show the revisions as a short table: number, status, source, message,
author, date.

### rollback <n>

Ask for confirmation first: this makes revision n what the agent runs (as a new revision; nothing is
lost). Then call `agents_workspace_rollback` with `revision` = n and report the new revision. The
person's own draft must be published or discarded first; say so when the answer asks for it.
