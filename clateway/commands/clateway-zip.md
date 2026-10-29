---
description: "Pack a Claude Code skill into one complete zip for Clateway's upload (Hire an agent → Import from Claude Code): the skill, every script and file it uses, skills it calls and a checked package, made portable for the sandbox. No Clateway sign-in needed. Usage: '/clateway-zip company-gif'."
---

## Pack a skill into one complete zip for Clateway

Make one zip of the skill named in the arguments that holds **everything** the agent needs, so the
person uploads it on clateway.ai: **AI agents → Hire an agent → Import from Claude Code → Upload zip
or file** (platform admins: Advanced agents → Import). No connection to Clateway is needed. Use
`/clateway-export` instead when the `clateway` MCP server is connected: it also tests the agent in a
real sandbox and deploys it.

Clateway only reads what is **inside the skill's folder in the zip**. A script in the project's
`scripts/`, a template in `assets/`, another skill it calls: if it is not in the zip, the agent does
not have it. Work through every step; do not stop at "zip the folder".

### 1. Find the skill

Look for `.claude/skills/<name>/SKILL.md`, `.claude/commands/<name>.md` or `~/.claude/commands/<name>.md`.
If the name is missing or ambiguous, list the skills and ask which one. Read it fully.

### 2. Make an inventory of everything it uses

Run the scanner from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-skill.mjs" <skill file> --root . --package /tmp/clateway-package.json
```

Then complete what a scanner cannot see, by reading the skill and its scripts yourself:

| What | Where it goes |
| --- | --- |
| The skill text (SKILL.md or the command .md) | `agent.instructions`, adapted for autonomous work |
| Reference markdown next to it (guides, examples, style rules) | in the skill folder; the package keeps it in `instructions` or `files` |
| Every script it runs, and every script those import | `scripts` (under `scripts/`) or `files` (at their project path) |
| Every file a script reads: configs, templates, prompts, fonts, images, sample data, JSON schemas | `files`, at the path the script reads it from |
| `requirements.txt` / `package.json` of the scripts | `requirements.python_packages` / `node_packages` |
| Code shown only inline (fenced blocks run by hand) | turned into real script files in `scripts` |
| Programs it starts (ffmpeg, pandoc, a browser, soffice) | `requirements.tools`; check them against the sandbox list in `/clateway-export` |
| Hosts it calls (APIs, fonts, CDNs) | `requirements.domains`, network `allowlist` |
| Environment variables (API keys) | `secrets_needed`: names, description, hosts; **never values** |
| Other skills it calls (`/other-skill`) | their rules folded into `instructions` (the zip also adds them as `references/<name>.md`) |
| MCP tools it calls (Evaboot, GitHub, …) | `integrations_needed` with the exact tool names |
| Rules from memory files and CLAUDE.md that matter for this skill | `memory_seeds` (no personal or secret data) |

### 3. Make it portable

The agent runs in a Linux sandbox at `/workspace`, offline unless the package asks for network:
- Replace every local path (`/Users/...`, `~/...`, `<project>/node_modules/...`) with a path inside
  `/workspace` (files land at their package path, scripts under `/workspace/scripts/...`) or a package import.
- Per-run data (the company in "/company-gif Acme") becomes an input: the agent writes the JSON the
  script reads before running it. Outputs go to `/workspace/out`.
- A program the sandbox lacks cannot be installed (no apt): use a listed one or an npm / pip package.

Run the scanner again after your changes until `sandbox.ok` is true.

### 4. Finish the package

Fill in every `TODO` in `/tmp/clateway-package.json` as described in step 3 of `/clateway-export`:
`skill` (key, name, description, category), `agent` (name, roleTitle, persona, mission, instructions
with exactly how to run the entrypoint and with which input), `secrets_needed`, `integrations_needed`,
`memory_seeds`, `tasks` and **1–3 `evals`** (a small real run with `must_include` / `expect_files`).
Mark one script `"entrypoint": true`.

Limits (the zip refuses a package over them): 20 scripts (~375 KB each), 20 files (~1.5 MB each),
~9 MB of scripts and files together, instructions up to 100,000 characters, 50 memory seeds, zip up to
60 MB. Too much data? Keep a sample and tell the agent to load the real file with `sandbox_load_file`.

### 5. Zip it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zip-skill.mjs" <skill folder or .md> --root . --package /tmp/clateway-package.json --out <name>.zip
```

The zipper checks the package (no TODO, limits, an entrypoint, evals, no secret values), scans the skill
again and adds the scripts and files it uses from elsewhere in the project at their project path, the
skills it calls as `references/<name>.md`, then reads the zip back to verify every file. It leaves out
secrets (`.env`, keys, any file that holds something like a key), `node_modules`, caches and lockfiles.

Read the JSON report: `added_from_project`, `related_skills`, `skipped` and `warnings`. A file in
`skipped` with "holds a key" means a secret is written in a file: move it to an environment variable
and list it in `secrets_needed`. Fix and zip again until there are no warnings you cannot explain.

### 6. Tell the person

Give the full path of the zip, what it holds (scripts, files, references, package) and the next steps:
1. clateway.ai → AI agents → Hire an agent → Import from Claude Code → **Upload zip or file**.
2. Check what Clateway found, then **Test in a sandbox** before **Deploy agent**.
3. Enter the secrets the package names (agent → Teamwork → Sandbox → Secrets), with the hosts they are for.
