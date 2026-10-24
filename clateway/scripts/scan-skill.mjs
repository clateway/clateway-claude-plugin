#!/usr/bin/env node
/**
 * Clateway skill scanner (Claude Code plugin "clateway", /clateway-export).
 *
 * Reads a Claude Code skill (.claude/commands/<name>.md or a SKILL.md) and follows every script it
 * uses, so a Clateway agent package lists exactly what the skill needs instead of what a model
 * remembers: script files and the files they read, npm / pip packages with the versions of the
 * project's lockfiles, programs the scripts start, environment variables they read (secrets), and
 * paths that only exist on this machine. It compares all of that with what the Clateway agent
 * sandbox has (sandbox-packages.json, a copy of agentcore/workspace/sandbox-packages.json).
 *
 *   node scan-skill.mjs <skill.md> [--root <project folder>] [--package <out.json>]
 *
 * Prints the report as JSON. With --package it also writes a package skeleton with every file
 * base64-encoded, requirements and secrets_needed filled in; the agent identity is left for Claude.
 * Node 18+, no dependencies.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_FILES = 60;

const SCRIPT_EXT = { '.mjs': 'node', '.js': 'node', '.cjs': 'node', '.ts': 'typescript', '.mts': 'typescript', '.py': 'python', '.sh': 'bash' };
const DATA_EXT = new Set(['.json', '.html', '.htm', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ttf', '.otf', '.woff', '.woff2',
  '.csv', '.tsv', '.yaml', '.yml', '.txt', '.md', '.xml', '.toml', '.ini', '.docx', '.pptx', '.xlsx', '.pdf', '.mp3', '.wav', '.mp4', '.hbs', '.mustache', '.j2', '.sql',
  // Sources a skill reads as text (e.g. an SVG template inside a React component).
  '.tsx', '.jsx', '.vue', '.svelte']);
/** Hosts that are never a dependency (documentation, examples). */
const IGNORED_HOSTS = new Set(['example.com', 'www.example.com', 'localhost', 'github.com', 'docs.github.com', 'claude.ai', 'code.claude.com', 'www.w3.org']);
const FENCE_KIND = { js: 'node', javascript: 'node', mjs: 'node', node: 'node', ts: 'typescript', typescript: 'typescript', py: 'python', python: 'python', bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash' };
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));
const PY_STDLIB = new Set(('abc argparse array ast asyncio base64 binascii bisect builtins calendar collections colorsys concurrent configparser contextlib copy csv ctypes dataclasses datetime decimal difflib email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging lzma math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tarfile tempfile textwrap threading time timeit tkinter traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo __future__').split(' '));
/** Import name → pip package where they differ. */
const PY_IMPORT_TO_PIP = { PIL: 'pillow', docx: 'python-docx', pptx: 'python-pptx', yaml: 'pyyaml', bs4: 'beautifulsoup4', fitz: 'pymupdf', cv2: 'opencv-python-headless', sklearn: 'scikit-learn', dateutil: 'python-dateutil', barcode: 'python-barcode', dotenv: 'python-dotenv', jwt: 'pyjwt', Crypto: 'pycryptodome' };
/** Shell words that are not programs. */
const SHELL_WORDS = new Set(('if then else elif fi for in do done while until case esac function return local export set unset shift exit echo printf read cd pwd test true false source eval exec trap wait sleep declare readonly let [ [[ ]] { } ( ) time command type').split(' '));
const COMMON_ENV = new Set(['HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'CI', 'NODE_ENV', 'DEBUG', 'TERM', 'NODE_PATH']);
const BINARY_ALIASES = { python: 'python3', pip3: 'pip', 'google-chrome': 'chromium', chrome: 'chromium', 'chromium-browser': 'chromium', imagemagick: 'convert' };

export function loadSandbox(file = join(HERE, 'sandbox-packages.json')) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  // "office" (LibreOffice) is only in the full sandbox image: usable, but the package then needs that image.
  return { tools: new Set(j.tools), officeTools: new Set(j.office?.tools ?? []), npm: new Set(Object.keys(j.npm)), pip: new Set(Object.keys(j.pip).map((x) => x.toLowerCase())) };
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
/** "a/b" for both separators. */
const posix = (p) => p.split(sep).join('/');
const npmName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** Paths a skill's text mentions (scripts, data files), as written. Pure. */
export function pathsInText(text) {
  const out = new Set();
  const re = /(?:^|[\s`'"(=])((?:\.{1,2}\/|~\/|\/)?[\w@.-]+(?:\/[\w@.-]+)*\.([a-z0-9]{1,6}))(?=$|[\s`'"),:;])/gim;
  for (const m of text.matchAll(re)) {
    const ext = `.${m[2].toLowerCase()}`;
    if (SCRIPT_EXT[ext] || DATA_EXT.has(ext)) out.add(m[1]);
  }
  return [...out];
}

/** Fenced code blocks of a markdown text with the runtime they are in. Pure. */
export function codeBlocks(text) {
  const out = [];
  for (const m of text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)) {
    const kind = FENCE_KIND[m[1].toLowerCase()];
    if (kind) out.push({ kind, code: m[2], index: m.index });
  }
  return out;
}

/** Hosts of the http(s) URLs in a text (APIs, fonts, CDNs the scripts reach). Pure. */
export function hostsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)) {
    const h = m[1].toLowerCase();
    if (!IGNORED_HOSTS.has(h) && !/\$\{|</.test(h)) out.add(h);
  }
  // Google Fonts (also when only named) loads its CSS from fonts.googleapis.com and the files from fonts.gstatic.com.
  if (out.has('fonts.googleapis.com') || /\bgoogle fonts\b/i.test(text)) { out.add('fonts.googleapis.com'); out.add('fonts.gstatic.com'); }
  return [...out].sort();
}

/** Imports of a JS / TS source: relative paths and package names. Pure. */
export function jsImports(src) {
  const specs = new Set();
  const res = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[\w*{}\s,$]*\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) specs.add(m[1]);
  const relative = [], packages = [];
  for (const s of specs) {
    // require('<project>/node_modules/playwright/index.js') is the package playwright.
    const viaModules = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(s);
    if (viaModules) { packages.push(viaModules[1]); continue; }
    if (s.startsWith('<')) continue;
    if (s.startsWith('.') || s.startsWith('/')) relative.push(s);
    else if (!s.startsWith('node:') && !NODE_BUILTINS.has(npmName(s))) packages.push(npmName(s));
  }
  return { relative, packages: [...new Set(packages)] };
}

/** Imports of a Python source: module names (top level) and relative ones. Pure. */
export function pyImports(src) {
  const mods = new Set(), rel = new Set();
  for (const m of src.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const x of m[1].split(',')) mods.add(x.trim().split('.')[0]);
  for (const m of src.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\b/gm)) (m[1] ? rel : mods).add(m[1] ? `${m[1]}${m[2]}` : m[2].split('.')[0]);
  return { modules: [...mods].filter(Boolean), relative: [...rel] };
}

/** Programs a script starts. Pure. */
export function binariesIn(src, kind) {
  const out = new Set();
  const add = (cmd) => {
    const word = String(cmd).trim().replace(/^(sudo|env|npx|exec)\s+/, '').split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '');
    if (!word || word.includes('$') || word.startsWith('-') || SHELL_WORDS.has(word) || /[=<>|&;]/.test(word)) return;
    const base = word.split('/').pop();
    if (/^[\w.+-]+$/.test(base)) out.add(BINARY_ALIASES[base] ?? base);
  };
  if (kind === 'node' || kind === 'typescript') {
    for (const m of src.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|execa|execaSync|fork)\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1]);
    for (const m of src.matchAll(/\b(?:exec|execSync)\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1]);
    for (const m of src.matchAll(/\$`([^`]+)`/g)) add(m[1]);
  } else if (kind === 'python') {
    for (const m of src.matchAll(/subprocess\.(?:run|call|check_call|check_output|Popen)\(\s*\[\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of src.matchAll(/subprocess\.(?:run|call|check_call|check_output|Popen)\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of src.matchAll(/os\.(?:system|popen)\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of src.matchAll(/shutil\.which\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
  } else {
    for (const raw of src.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line || /^[\w]+=/.test(line)) continue;
      for (const part of line.split(/\s*(?:&&|\|\||\||;)\s*/)) add(part);
    }
  }
  return [...out];
}

/** Install lines in a skill text ("brew install gifski", "pip install x", "npm i -g y"). Pure. */
export function installsIn(text) {
  const tools = new Set(), npm = new Set(), pip = new Set();
  for (const m of text.matchAll(/\b(?:brew|apt(?:-get)?|choco|winget)\s+install\s+([^\n`]+)/g)) for (const x of m[1].split(/\s+/)) if (/^[a-z0-9][\w.+-]*$/i.test(x) && !x.startsWith('-')) tools.add(BINARY_ALIASES[x] ?? x);
  for (const m of text.matchAll(/\bnpm\s+(?:i|install|add)\s+([^\n`]+)/g)) for (const x of m[1].split(/\s+/)) if (x && !x.startsWith('-')) npm.add(x);
  for (const m of text.matchAll(/\bpip3?\s+install\s+([^\n`]+)/g)) for (const x of m[1].split(/\s+/)) if (x && !x.startsWith('-') && !x.startsWith('/')) pip.add(x);
  return { tools: [...tools], npm: [...npm], pip: [...pip] };
}

/** Environment variables a script reads. Pure. */
export function envVarsIn(src, kind) {
  const out = new Set();
  const res = kind === 'python'
    ? [/os\.environ\[\s*['"](\w+)['"]\s*\]/g, /os\.environ\.get\(\s*['"](\w+)['"]/g, /os\.getenv\(\s*['"](\w+)['"]/g]
    : kind === 'bash'
      ? [/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g]
      : [/process\.env\.([A-Za-z_]\w*)/g, /process\.env\[\s*['"](\w+)['"]\s*\]/g, /Deno\.env\.get\(\s*['"](\w+)['"]/g];
  for (const re of res) for (const m of src.matchAll(re)) if (!COMMON_ENV.has(m[1])) out.add(m[1]);
  return [...out];
}

/** String literals that look like file paths; absolute ones only exist on this machine. Pure. */
export function pathLiteralsIn(src) {
  const out = [];
  for (const m of src.matchAll(/['"`]((?:~|\/Users|\/home|\/opt|\/tmp|[A-Za-z]:\\|\.{1,2}\/|[\w@-]+\/)[^'"`\n$]*?\.([a-z0-9]{1,6}))['"`]/gi)) {
    out.push({ value: m[1], index: m.index, ext: `.${m[2].toLowerCase()}` });
  }
  return out;
}

const isLocalOnly = (p) => /^(~|\/Users\/|\/home\/|\/opt\/|[A-Za-z]:\\|<project>|<repo>)/.test(p) || /(^|\/)node_modules\//.test(p);

function lockVersions(root) {
  const npm = {}, pip = {};
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const [k, v] of Object.entries(lock.packages ?? {})) if (k.startsWith('node_modules/') && v?.version) npm[k.slice('node_modules/'.length)] ??= v.version;
  } catch { /* no lockfile */ }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const [k, v] of Object.entries({ ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) })) npm[k] ??= String(v);
  } catch { /* no package.json */ }
  for (const f of ['requirements.txt', 'requirements-dev.txt']) {
    try {
      for (const line of readFileSync(join(root, f), 'utf8').split('\n')) {
        const m = /^\s*([A-Za-z0-9][\w.-]*)\s*(==|>=|~=)?\s*([\w.*]+)?/.exec(line);
        if (m && !line.trim().startsWith('#')) pip[m[1].toLowerCase()] ??= m[2] ? `${m[2]}${m[3]}` : '';
      }
    } catch { /* none */ }
  }
  return { npm, pip };
}

function resolveFile(base, spec, kind) {
  const p = resolve(base, spec);
  const tries = [p, ...(kind === 'python' ? [`${p}.py`, join(p, '__init__.py')] : ['.mjs', '.js', '.cjs', '.ts', '.mts'].flatMap((e) => [`${p}${e}`, join(p, `index${e}`)]))];
  return tries.find((t) => existsSync(t) && statSync(t).isFile()) ?? null;
}

/**
 * Scan a skill. `read` / `exists` can be replaced in tests. Returns the report (see the file header).
 */
export function scanSkill(skillPath, opts = {}) {
  const root = resolve(opts.root ?? process.cwd());
  const sandbox = opts.sandbox ?? loadSandbox();
  const skillText = readFileSync(skillPath, 'utf8');
  const report = {
    skill: posix(relative(root, resolve(skillPath))),
    scripts: [], files: [], packages: { npm: {}, pip: {} }, binaries: [], env_vars: [], hosts: [],
    local_paths: [], missing_files: [], skipped: [], warnings: [],
  };
  const versions = lockVersions(root);
  const seen = new Set();
  const queue = [];
  const inRoot = (abs) => !relative(root, abs).startsWith('..') && !isAbsolute(relative(root, abs));
  const enqueue = (abs, from) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    if (!inRoot(abs)) { report.skipped.push(`${abs}: outside the project (${from})`); return; }
    if (/(^|\/)node_modules\//.test(posix(abs))) { report.warnings.push(`${posix(relative(root, abs))} is inside node_modules (${from}): use the package instead`); return; }
    if (seen.size > MAX_FILES * 3) return;
    queue.push(abs);
  };

  const binaries = new Set(), env = new Set(), npm = new Set(), pip = new Set(), hosts = new Set(hostsIn(skillText));
  // Code written inline in the skill (fenced blocks) runs too: its imports, programs and variables count.
  const scanCode = (src, kind, where, offset = 0, text = src) => {
    binariesIn(src, kind).forEach((b) => binaries.add(b));
    envVarsIn(src, kind).forEach((e) => env.add(e));
    hostsIn(src).forEach((h) => hosts.add(h));
    if (kind === 'node' || kind === 'typescript') {
      const { packages, relative: rels } = jsImports(src);
      packages.forEach((n) => npm.add(n));
      for (const r of rels) if (isLocalOnly(r) || r.startsWith('/')) report.local_paths.push({ file: where, line: lineOf(text, offset + src.indexOf(r)), value: r });
      for (const m of src.matchAll(/require\(\s*['"](<[^'"]+)['"]/g)) report.local_paths.push({ file: where, line: lineOf(text, offset + m.index), value: m[1] });
    } else if (kind === 'python') {
      for (const m of pyImports(src).modules) if (!PY_STDLIB.has(m)) pip.add((PY_IMPORT_TO_PIP[m] ?? m).toLowerCase());
    }
  };
  const blockKinds = new Set();
  for (const block of codeBlocks(skillText)) { blockKinds.add(block.kind); scanCode(block.code, block.kind, report.skill, block.index, skillText); }
  const installs = installsIn(skillText);
  installs.tools.forEach((t) => binaries.add(t));
  installs.npm.forEach((n) => npm.add(npmName(n.replace(/@[^/@]*$/, '') || n)));
  installs.pip.forEach((n) => pip.add(n.replace(/[=<>!~[].*$/, '').toLowerCase()));
  for (const m of skillText.matchAll(/<(?:project|repo)>\/[^\s'"`)]+/g)) report.local_paths.push({ file: report.skill, line: lineOf(skillText, m.index), value: m[0] });
  for (const p of pathsInText(skillText)) {
    if (isLocalOnly(p)) { report.local_paths.push({ file: report.skill, line: lineOf(skillText, skillText.indexOf(p)), value: p }); continue; }
    const abs = resolve(root, p);
    if (existsSync(abs) && statSync(abs).isFile()) enqueue(abs, 'the skill');
    else if (SCRIPT_EXT[extname(p).toLowerCase()]) report.missing_files.push({ path: p, from: report.skill });
  }
  let entry = null;
  while (queue.length) {
    const abs = queue.shift();
    const rel = posix(relative(root, abs));
    const ext = extname(abs).toLowerCase();
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) { report.skipped.push(`${rel}: larger than ${MAX_FILE_BYTES} bytes`); continue; }
    const kind = SCRIPT_EXT[ext];
    if (!kind) { report.files.push({ path: rel, size }); continue; }
    entry ??= rel;
    report.scripts.push({ path: rel, runtime: kind, size, entrypoint: rel === entry });
    const src = readFileSync(abs, 'utf8');
    binariesIn(src, kind).forEach((b) => binaries.add(b));
    envVarsIn(src, kind).forEach((e) => env.add(e));
    hostsIn(src).forEach((h) => hosts.add(h));
    if (kind === 'node' || kind === 'typescript') {
      const { relative: rels, packages } = jsImports(src);
      packages.forEach((n) => npm.add(n));
      for (const r of rels) {
        const f = resolveFile(dirname(abs), r, kind);
        if (f) enqueue(f, rel); else report.missing_files.push({ path: r, from: rel });
      }
    } else if (kind === 'python') {
      const { modules, relative: rels } = pyImports(src);
      for (const m of modules) {
        const local = resolveFile(dirname(abs), m, 'python') ?? resolveFile(root, m, 'python');
        if (local) enqueue(local, rel);
        else if (!PY_STDLIB.has(m)) pip.add((PY_IMPORT_TO_PIP[m] ?? m).toLowerCase());
      }
      for (const r of rels) {
        const up = r.match(/^\.+/)[0].length - 1;
        const base = resolve(dirname(abs), ...Array(up).fill('..'));
        const f = resolveFile(base, r.replace(/^\.+/, '').replace(/\./g, '/') || '__init__', 'python');
        if (f) enqueue(f, rel);
      }
    }
    for (const lit of pathLiteralsIn(src)) {
      if (isLocalOnly(lit.value)) { report.local_paths.push({ file: rel, line: lineOf(src, lit.index), value: lit.value }); continue; }
      if (!DATA_EXT.has(lit.ext) && !SCRIPT_EXT[lit.ext]) continue;
      const f = [resolve(dirname(abs), lit.value), resolve(root, lit.value)].find((x) => existsSync(x) && statSync(x).isFile());
      if (f) enqueue(f, rel);
    }
  }
  if (report.scripts.length + report.files.length > MAX_FILES) report.warnings.push(`More than ${MAX_FILES} files: the package may be too large`);

  report.binaries = [...binaries].sort();
  report.env_vars = [...env].sort();
  report.hosts = [...hosts].sort();
  const seenLocal = new Set();
  report.local_paths = report.local_paths.filter((l) => { const k = `${l.file}:${l.line}:${l.value}`; return !seenLocal.has(k) && seenLocal.add(k); });
  for (const n of [...npm].sort()) report.packages.npm[n] = versions.npm[n] ?? '';
  for (const n of [...pip].sort()) report.packages.pip[n] = versions.pip[n] ?? '';

  const runtimes = new Set([...report.scripts.map((s) => s.runtime), ...[...blockKinds].filter((k) => k !== 'bash')]);
  const needed = new Set([...report.binaries, ...(runtimes.has('node') || runtimes.has('typescript') ? ['node'] : []), ...(runtimes.has('python') ? ['python3'] : [])]);
  const office = sandbox.officeTools ?? new Set();
  const missingTools = [...needed].filter((t) => !sandbox.tools.has(t) && !office.has(t));
  const fullImage = [...needed].some((t) => office.has(t));
  const npmToInstall = Object.keys(report.packages.npm).filter((n) => !sandbox.npm.has(n));
  const pipToInstall = Object.keys(report.packages.pip).filter((n) => !sandbox.pip.has(n));
  const media = ['ffmpeg', 'gifski', 'chromium', 'convert', 'sox', 'soffice'].some((t) => needed.has(t)) || 'playwright' in report.packages.npm || 'playwright' in report.packages.pip;
  report.sandbox = {
    image: fullImage ? 'full' : 'standard',
    missing_tools: missingTools,
    npm_to_install: npmToInstall,
    pip_to_install: pipToInstall,
    ok: missingTools.length === 0 && report.local_paths.length === 0 && report.missing_files.length === 0,
  };
  report.requirements = {
    sandbox_profile: media ? 'media' : runtimes.has('python') && !runtimes.has('node') ? 'data-python' : 'full-stack',
    // Hosts the code calls need an allowlist; installing packages needs the registries.
    network: report.hosts.length ? 'allowlist' : npmToInstall.length || pipToInstall.length ? 'registries' : 'none',
    domains: report.hosts,
    tools: [...needed].sort(),
    node_packages: Object.entries(report.packages.npm).map(([n, v]) => (v && !sandbox.npm.has(n) ? `${n}@${v.replace(/^[\^~]/, '')}` : n)),
    python_packages: Object.entries(report.packages.pip).map(([n, v]) => (v && !sandbox.pip.has(n) ? `${n}${/^[0-9]/.test(v) ? '==' : ''}${v}` : n)),
  };
  report.secrets_needed = report.env_vars.map((name) => ({ name, description: '', domains: [], required: true }));
  if (fullImage) report.warnings.push('Uses LibreOffice (soffice): runs only where the platform offers the full sandbox image. Convert with pandoc, docx / pptxgenjs or python-docx / python-pptx instead if you can.');
  if (missingTools.length) report.warnings.push(`Not in the Clateway sandbox and not installable by the agent: ${missingTools.join(', ')}. Use another tool or an npm / pip package that bundles it.`);
  if (report.local_paths.length) report.warnings.push('Paths that only exist on this machine: make them inputs or files in the package.');
  if (report.hosts.length && (npmToInstall.length || pipToInstall.length)) report.warnings.push('The code reaches hosts and also needs packages installed: list the packages so the image or the agent settings carry them, or add the registry hosts.');
  return report;
}

const b64 = (abs) => readFileSync(abs).toString('base64');

/** A package skeleton from a report: files, requirements, secrets; the identity is for Claude to fill. */
export function packageSkeleton(report, root, skillKey) {
  const underScripts = (p) => p.startsWith('scripts/');
  return {
    format: 'clateway-skill-package',
    version: '1.0',
    skill: { key: skillKey, name: 'TODO', description: 'TODO' },
    agent: { name: 'TODO', roleTitle: 'TODO', mission: 'TODO', instructions: 'TODO: the skill adapted for autonomous work; run the entrypoint as shown below', capabilities: ['sandbox'] },
    // Scripts under scripts/ keep their path in /workspace/scripts; others travel as files at their own
    // path, so the project's layout (and relative paths between files) is the same in /workspace.
    scripts: report.scripts.filter((s) => underScripts(s.path)).map((s) => ({ path: s.path, runtime: s.runtime, entrypoint: s.entrypoint, content: b64(resolve(root, s.path)) })),
    files: [
      ...report.scripts.filter((s) => !underScripts(s.path)).map((s) => ({ path: s.path, description: `${s.runtime} script${s.entrypoint ? ' (entrypoint)' : ''}`, content: b64(resolve(root, s.path)) })),
      ...report.files.map((f) => ({ path: f.path, content: b64(resolve(root, f.path)) })),
    ],
    requirements: report.requirements,
    secrets_needed: report.secrets_needed,
    evals: [{ task: 'TODO: a small real run of the skill', expect_files: [] }],
    tasks: { default: 'TODO', examples: [] },
  };
}

function main(argv) {
  const args = argv.slice(2);
  const skill = args.find((a) => !a.startsWith('--') && !['--root', '--package'].includes(args[args.indexOf(a) - 1]));
  if (!skill) {
    console.error('Usage: node scan-skill.mjs <skill.md> [--root <project folder>] [--package <out.json>]');
    process.exit(2);
  }
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const report = scanSkill(skill, { root });
  if (args.includes('--package')) {
    const out = args[args.indexOf('--package') + 1];
    const key = skill.split(/[\\/]/).pop().replace(/\.md$/i, '').replace(/^SKILL$/i, dirname(skill).split(/[\\/]/).pop()).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    writeFileSync(out, JSON.stringify(packageSkeleton(report, resolve(root), /^[a-z]/.test(key) ? key : `skill_${key}`), null, 2));
    report.package_written = out;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv);
