---
description: "Pack a Claude Code skill into a zip for Clateway's upload (Hire an agent → Import from Claude Code): checked with the scanner, with the finished package inside. No Clateway sign-in needed. Usage: '/clateway-zip company-gif'."
---

## Pack a skill for the Clateway upload

Make a zip of the skill named in the arguments that the person uploads on clateway.ai: **AI agents →
Hire an agent → Import from Claude Code → Upload zip or file** (platform admins: Advanced agents →
Import). This needs no connection to Clateway. Use `/clateway-export` instead when the `clateway` MCP
server is connected: it also tests the agent in a real sandbox and deploys it.

### 1. Find the skill

Look for `.claude/skills/<name>/SKILL.md`, `.claude/commands/<name>.md` or `~/.claude/commands/<name>.md`.
If the name is missing or ambiguous, list the skills and ask which one.

### 2. Scan it and make it portable

Do steps 2 and 3 of `/clateway-export` (scan with `scripts/scan-skill.mjs`, fix local paths and inline
code, fill in the package at `/tmp/clateway-package.json`), so the agent runs in the Clateway sandbox
and not only on this machine:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-skill.mjs" <skill file> --root . --package /tmp/clateway-package.json
```

Run the scanner again after your changes until `sandbox.ok` is true. Scripts or files the skill uses
from outside its folder must be in the package (`scripts` / `files`): Clateway only reads what is in
the zip.

### 3. Zip it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zip-skill.mjs" <skill folder or .md> --package /tmp/clateway-package.json --out <name>.zip
```

The zip holds the skill folder and the package (`<name>.clateway-skill.json`), which Clateway uses as
it is. It leaves out secrets (`.env`, keys), `node_modules`, caches and lockfiles; check `skipped` in the
report. Clateway reads up to 60 MB.

### 4. Tell the person

Give the path of the zip and the next steps:
1. clateway.ai → AI agents → Hire an agent → Import from Claude Code → **Upload zip or file**.
2. Check what Clateway found, then **Test in a sandbox** before **Deploy agent**.
3. Enter the secrets the package names (agent → Teamwork → Sandbox → Secrets), with the hosts they are for.
