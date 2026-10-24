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

## Install

In Claude Code:

```
/plugin marketplace add clateway/clateway-claude-plugin
/plugin install clateway@clateway
```

Restart Claude Code if `/clateway-export` does not show up. Updates: `/plugin marketplace update clateway`.

## Use

1. **Connect Clateway:** `/mcp` → `clateway` → sign in with your Clateway account and choose the company.
   A company owner or admin first switches on *Manage Company → Integrations → AI agent access* and the `agents_*`
   tools there.
2. **Export a skill:** `/clateway-export company-gif` (any skill in `.claude/commands`, `.claude/skills` or
   `~/.claude/commands`).
3. **Only the scan:**
   `node <plugin folder>/clateway/scripts/scan-skill.mjs .claude/commands/<skill>.md --root . --package package.json`

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
