---
description: "Export a Claude Code skill, plugin or team of subagents as Clateway AI agents: scan what it needs, test it in a real Clateway agent sandbox, fix, deploy. Usage: '/clateway-export company-gif' (a skill in .claude/commands or .claude/skills), '/clateway-export --plugin <folder>' (a plugin or a project with .claude/agents)."
---

## Export a skill to Clateway

Turn the skill named in the arguments into a Clateway agent package, prove it runs in a real
Clateway agent sandbox, then deploy it. Work through the steps in order and do not skip the test.
Nobody wants an agent that fails on its first task.

The Clateway MCP server of this plugin (`clateway`) must be connected: sign in when Claude Code asks
(OAuth, your Clateway account and company). Its tools are `agents_deploy_skill_package`,
`agents_test_skill_package`, `agents_get_skill_test` and `agents_setup_integration`.

Not connected, or the `agents_*` tools are switched off for the company? Do steps 1–3, then pack the
skill with `/clateway-zip` (step 5 there) and tell the person to upload the zip on clateway.ai: AI agents →
Hire an agent → Import from Claude Code → Upload zip or file, then Test in a sandbox and Deploy agent.

### 0. A whole plugin or a team of subagents

When the arguments name a plugin folder (with `.claude-plugin/plugin.json`), say `--plugin`, or the project has
subagents in `.claude/agents/` that the skill works with, export the whole thing as one **agent package**
(format `clateway-agent-package` 2.0) instead of steps 1–3:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-plugin.mjs" <plugin or project folder> --root . --package /tmp/clateway-package.json
```

It reads every skill (`skills/*/SKILL.md`), command (`commands/*.md`), subagent (`agents/*.md` with its tools and
model), MCP server (`.mcp.json`, plugin.json `mcpServers`) and hook, scans the skills' scripts with the skill
scanner, and writes a package in which a lead agent holds the skills and delegates to the subagents (a team).
Secrets are named, never copied. Hooks and local (stdio) MCP servers are listed under `not_translated` with the
reason: tell the person about each one. Then:

- Fill in what the scanner could not know: a better `roleTitle` / `mission` for the lead, `evals` (replace the
  TODO), `description` and `domains` of each secret. Keep every agent's instructions as written; only replace
  Claude Code specific steps ("ask the user") with "propose actions and wait for approval".
- Fix every warning of the report (paths that only exist on this machine, limits), as in step 2.
- Continue with step 4. For a team, the dry run lists the agents: until Clateway imports whole teams, deploy and
  test the lead by passing its key as `agent_key` (the `team.lead` of the package) and tell the person that the other agents follow once team
  import is available. If the dry run answers that the format must be `clateway-skill-package`, the Clateway
  version is older: export the main skill alone with steps 1–3.

### 1. Find the skill

Look for `.claude/commands/<name>.md`, `.claude/skills/<name>/SKILL.md` or `~/.claude/commands/<name>.md`.
If the name is missing or ambiguous, list the skills and ask which one.

### 2. Scan it (don't guess)

Run the scanner from this plugin on the skill, from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-skill.mjs" <skill file> --root . --package /tmp/clateway-package.json
```

It follows every script and the files they read and reports, as JSON:
- `scripts` / `files`: what the package must carry (written base64-encoded into the skeleton)
- `packages`: npm / pip packages with the versions of the lockfiles (else the installed version)
- `dependencies` / `dependencies_markdown`: every package with the version it was run with, whether
  it is in the sandbox image, and the `npm install` / `pip install` line; a "Packages used" section
- `binaries`: programs the scripts start; `sandbox.missing_tools` lists those the sandbox lacks
- `env_vars`: variables the scripts read; they become `secrets_needed` (never their values)
- `hosts`: hosts the code calls; they become the allowlist network
- `local_paths` / `missing_files`: paths that only exist on this machine, imports that could not be found
- `requirements`: profile, network, hosts, tools and packages for the package

Read every warning. Then make the skill portable:
- Replace every local path (`/Users/...`, `~/...`, `<project>/node_modules/...`) with a path inside
  `/workspace` (the package `files` land at their project path, scripts under `scripts/` at
  `/workspace/scripts/...`) or with a package import (`import { chromium } from "playwright"`).
- Write per-run data (e.g. the company in "/company-gif Acme") as an input: the agent researches it
  and writes the JSON file the script reads, before running the script.
- Code that only lives inline in the skill (fenced blocks the person runs by hand) must become real
  script files in the package, run by the agent with `node` / `python3`.
- A program in `sandbox.missing_tools` cannot be installed by the agent (no apt). Use what the
  sandbox has (below) or an npm / pip package that bundles it.

What the Clateway sandbox already has, usable offline without `npm install`:
Node.js 22, Python 3, Playwright 1.55 with Chromium, ffmpeg, gifski, sox, ImageMagick, rsvg-convert,
Graphviz, exiftool, poppler, qpdf, Ghostscript, pandoc, Tesseract OCR, fonts (LibreOffice headless only in
the full image: `sandbox.image` "full" in the report; prefer pandoc / docx / pptxgenjs when that works);
npm: playwright, pdf-lib, pdfkit, pdfjs-dist, pdf-parse, docx, docxtemplater, mammoth, exceljs,
pptxgenjs, papaparse, csv-parse, sharp, @napi-rs/canvas, @resvg/resvg-js, satori, jimp, gifenc,
fluent-ffmpeg, lamejs, music-metadata, chart.js, vega, vega-lite, echarts, qrcode, bwip-js, marked,
markdown-it, turndown, cheerio, jsdom, handlebars, mjml, yaml, zod, ajv, date-fns, dayjs, lodash,
jszip, archiver; pip: pandas, openpyxl, python-docx, python-pptx, matplotlib, pillow, reportlab,
weasyprint, pypdf, pdfplumber, pymupdf, docxtpl, xlsxwriter, moviepy, pydub, plotly, beautifulsoup4,
jinja2, pyyaml, lxml, pydantic, httpx, requests. (The full list is `scripts/sandbox-packages.json`.)
Anything else is installed at sandbox start from `requirements.node_packages` / `python_packages`,
which needs network `registries`.

Run the scanner again after your changes until `sandbox.ok` is true.

### 3. Complete the package

Open `/tmp/clateway-package.json` and fill in what the scanner left as TODO:
- `skill`: key (snake_case), name, description, category
- `agent`: name, roleTitle, persona, mission and `instructions`: the skill adapted for autonomous
  work ("the person" instead of "the user", no Claude Code specific steps, "propose actions and wait
  for approval"), with exactly how to run the entrypoint and with which input file. Clateway adds a
  "Your sandbox" section (where the files are, what is installed) itself. End the instructions with
  the scanner's `dependencies_markdown` ("Packages used": package, version, sandbox, install line).
- `requirements.node_packages` / `python_packages`: every package the scripts import, with the exact
  version the skill was tested with (`name@1.2.3`, `name==1.2.3`) for packages the sandbox does not
  have. A range (`^9.0.0`) or no version: look it up (`npm ls <name>`, `pip show <name>`) and pin it.
  Packages in the sandbox image keep their name only (the image version is used); never pin Playwright.
- `secrets_needed`: a description and the `domains` (hosts) for each variable; `shared: true` only for a team key that colleagues' tasks may use too (default: only the agent owner's tasks)
- `evals`: 1–3 small real runs that prove the setup end to end, e.g.
  `{ "task": "Make the platform story GIF for Acme Bakeries", "must_include": ["Acme"], "expect_files": [".gif"] }`
- `integrations_needed`, `memory_seeds` (rules from memory files), `tasks.default`, `tasks.examples`

### 4. Check, test, fix (loop)

1. `agents_deploy_skill_package` with `{ package, dry_run: true }`: fix every `runtime` blocker
   and every required integration (or set it up with `agents_setup_integration`).
2. `agents_test_skill_package` with `{ package }`: runs the first eval once in a real sandbox
   (test mode: nothing changes). Poll `agents_get_skill_test` with the `run_id` every 20–30 s until
   `done`. Read `checks`, `files`, `error` and the last `steps` (sandbox commands and their errors).
3. Not passed? Fix the package (scripts, files, requirements, instructions) and test again. Stop
   after 5 attempts and tell the person what still fails and why.

### 5. Deploy

When the test passes, `agents_deploy_skill_package` with `{ package }`. Show the agent URL, the
secrets the person still has to enter (agent → Teamwork → Sandbox → Secrets) and the integrations
that need setting up. Save the final package next to the skill as `<name>.clateway-skill.json`. If the
person also wants a file to share or upload elsewhere, make the zip with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/zip-skill.mjs" <skill folder> --root . --package <name>.clateway-skill.json` (it adds the scripts and files from elsewhere in the project and checks the package).
