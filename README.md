# Clateway plugin for Claude Code

Turn a [Claude Code](https://claude.com/claude-code) skill into a [Clateway](https://clateway.ai) AI agent,
tested in a real Clateway agent sandbox before anyone relies on it.

`/clateway-export <skill>`:

1. **Scans** the skill with `scripts/scan-skill.mjs`: its scripts, inline code and the files they read, npm / pip
   packages (with the versions in your lockfiles), programs (ffmpeg, LibreOffice, …), environment variables
   (secrets), hosts, and paths that only exist on your machine, compared with what the Clateway sandbox has.
2. **Builds** a portable Clateway skill package from that report.
3. **Tests** it once in a real Clateway sandbox (test mode, nothing changes), fixes what fails and tests again.
4. **Deploys** it as an agent on your company's AI team (clateway.ai/ai-agents), after asking you.

`/clateway-zip <skill>` does the scan and the package without signing in to Clateway and writes **one complete
zip**: the skill folder, every script and file it uses from elsewhere in the project (at their project path), the
skills it calls (as `references/<name>.md`) and the finished package, checked against Clateway's limits and read
back to verify. Files holding something like a key are never packed. Upload it yourself: clateway.ai → AI agents → Hire an agent → Import from Claude
Code → **Upload zip or file**, then **Test in a sandbox** and **Deploy agent**.

No plugin at all? Zip the skill folder (with its `SKILL.md`, scripts and files) and upload that: Clateway reads the
instructions, scripts, files, packages, hosts and secrets from it. The plugin's scan makes a skill portable first
(local paths, inline code, programs the sandbox lacks), so its agents fail less often.

## Install

Run these in a **terminal (shell), not inside a Claude Code session**:

```bash
claude plugin marketplace add clateway/clateway-claude-plugin
claude plugin install clateway@clateway
```

Then start `claude` in your project. `/clateway-export` is available; check with `claude plugin list`, which shows
`clateway@clateway` as enabled.

Typing `/plugin marketplace add …` in a chat answers "/plugin isn't available in this environment" wherever the
plugin browser does not exist, such as non-interactive runs (`claude -p`) and cloud sessions. Use the commands above
instead. Other places:

- **Claude desktop app** (local session): **+** next to the prompt box → **Add plugins** → add the marketplace
  `clateway/clateway-claude-plugin`.
- **VS Code:** `/plugins` → **Marketplaces** → add `clateway/clateway-claude-plugin`.
- **Cloud sessions** (claude.ai/code, mobile, desktop cloud): plugins are not loaded there, not even ones a
  repository turns on in `.claude/settings.json`. Run the export from a terminal on your own machine.

Updates, also in a terminal:

```bash
claude plugin marketplace update clateway
claude plugin update clateway@clateway
```

Restart Claude Code afterwards.

## Use

1. **Connect Clateway:** `/mcp` → `clateway` → sign in with your Clateway account and choose the company.
   A company owner or admin first switches on *Manage Company → Integrations → AI agent access* and the `agents_*`
   tools there.
2. **Export a skill:** `/clateway-export company-gif` (any skill in `.claude/commands`, `.claude/skills` or
   `~/.claude/commands`).
3. **Without signing in:** `/clateway-zip company-gif` writes `company-gif.zip` to upload on clateway.ai.
4. **Only the scan:**
   `node ~/.claude/plugins/cache/clateway/clateway/<version>/scripts/scan-skill.mjs .claude/commands/<skill>.md --root . --package package.json`
   (the plugin's installed folder; `<version>` is the one `claude plugin list` shows, for example `1.2.0`)
5. **Only the zip:** `node …/scripts/zip-skill.mjs .claude/skills/<skill> --root . --out <skill>.zip` (add
   `--package <file>` to put a finished package in it, `--no-scan` to pack only the skill folder).

Secrets are never put in a package: the agent's owner enters their values in Clateway after the deploy (agent →
Teamwork → Sandbox → Secrets), where they are stored encrypted.

## What the sandbox has

`clateway/scripts/sandbox-packages.json` lists the programs and packages of the Clateway agent sandbox. There are
two images: **standard** (documents, PDF, images, GIF / audio / video, charts, OCR) and **full** (the same plus
LibreOffice headless). A skill that needs `soffice` runs on the full image where the platform offers it; the
scanner says so (`sandbox.image` in its report).

## Development

```
npm test
```

Node 20+, no dependencies. Clateway maintainers keep `sandbox-packages.json` in step with the sandbox image.
