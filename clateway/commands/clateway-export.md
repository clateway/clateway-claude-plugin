---
description: "Export a Claude Code skill as a Clateway AI agent: scan what it needs, test it in a real Clateway agent sandbox, fix, deploy. Usage: '/clateway-export company-gif' (a skill in .claude/commands or .claude/skills)."
---

## Export a skill to Clateway

Turn the skill named in the arguments into a Clateway agent package, prove it runs in a real
Clateway agent sandbox, then deploy it. Work through the steps in order and do not skip the test.
Nobody wants an agent that fails on its first task.

The Clateway MCP server of this plugin (`clateway`) must be connected: sign in when Claude Code asks
(OAuth, your Clateway account and company). Its tools are `agents_deploy_skill_package`,
`agents_test_skill_package`, `agents_get_skill_test` and `agents_setup_integration`.

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
- `packages`: npm / pip packages with the versions of the lockfiles
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
  "Your sandbox" section (where the files are, what is installed) itself.
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
that need setting up. Save the final package next to the skill as `<name>.clateway-skill.json`.
