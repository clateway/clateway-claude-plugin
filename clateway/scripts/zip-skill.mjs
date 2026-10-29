#!/usr/bin/env node
/**
 * Packs a Claude Code skill into one complete zip for Clateway's "Import from Claude Code" upload
 * (Hire an agent, or admin → Advanced agents → Import). Clateway only reads what is inside the
 * skill's folder in the zip, so this puts everything the skill needs there:
 *
 *  - the skill folder itself (SKILL.md or the command .md, reference files, scripts, data);
 *  - every script and file the skill uses from elsewhere in the project (found by scan-skill.mjs),
 *    at its project path, so it lands at the same /workspace path as in a package;
 *  - other skills it calls (/other-skill), as references/<name>.md;
 *  - the finished package (.clateway-skill.json, from /clateway-zip or /clateway-export), which
 *    Clateway then uses as it is; it is checked first against Clateway's package limits.
 *
 * Leaves out what never belongs in a package: secrets (.env, keys, files holding a key),
 * dependencies and caches (node_modules, __pycache__, .git, …). Reads the zip back to verify it.
 *
 *   node zip-skill.mjs <skill folder | SKILL.md | command .md> [--root .] [--package pkg.json]
 *                      [--out skill.zip] [--no-scan]
 *
 * Prints a JSON report. Node 20+, no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanSkill } from './scan-skill.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '__MACOSX', '.idea', '.vscode']);
const SKIP_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.pyc|.*\.log|.*\.zip)$/i;
const SECRET_FILES = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials(\.json)?)$/i;
/** Clateway reads at most this much from a zip. */
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;
/** Clateway's package limits (supabase/functions/_shared/ai-workforce/skill-package.ts). */
export const PACKAGE_LIMITS = { scripts: 20, files: 20, scriptB64: 500_000, fileB64: 2_000_000, totalB64: 12_000_000, instructions: 100_000, memorySeeds: 50 };
/** Text that looks like a real key or token: such a file is never packed. */
const SECRET_CONTENT = /(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|re_[A-Za-z0-9]{20,}_[A-Za-z0-9]{10,})/;

// ── zip writer (deflate, or stored when that is not smaller) ─────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of [{ name, data }] (names with forward slashes). Pure. */
export function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ── reading a zip back (verification) ────────────────────────────────────────

/** The entries of a zip as { name: Buffer }, checking every CRC. Pure. */
export function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Not a zip: no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out[name] = data;
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

// ── the skill folder ─────────────────────────────────────────────────────────

const isText = (buf) => !buf.subarray(0, 8000).includes(0);
/** Whether a file's text holds something that looks like a real key. Pure. */
export const holdsSecret = (buf) => isText(buf) && SECRET_CONTENT.test(buf.toString('utf8'));

/** The files of a skill folder to pack, and what was left out (with why). */
export function collectSkill(target) {
  const stat = fs.statSync(target);
  const single = stat.isFile();
  const dir = single && path.basename(target).toLowerCase() !== 'skill.md' ? null : single ? path.dirname(target) : target;
  const files = [];
  const skipped = [];
  if (!dir) {
    files.push({ abs: path.resolve(target), rel: path.basename(target) });
    return { name: path.basename(target, '.md'), dir: null, main: path.resolve(target), files, skipped };
  }
  const mds = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  if (!fs.existsSync(path.join(dir, 'SKILL.md')) && !mds.length) throw new Error(`No SKILL.md (or other .md) in ${dir}`);
  const main = path.resolve(dir, fs.existsSync(path.join(dir, 'SKILL.md')) ? 'SKILL.md' : mds.find((f) => !/^readme\.md$/i.test(f)) ?? mds[0]);
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) { skipped.push({ path: r, why: 'symbolic link' }); continue; }
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) { skipped.push({ path: `${r}/`, why: 'dependencies or cache' }); continue; }
        walk(a, r);
      } else if (SECRET_FILES.test(ent.name)) {
        skipped.push({ path: r, why: 'secret: enter it in the agent\'s sandbox settings instead' });
      } else if (!SKIP_FILES.test(ent.name)) {
        files.push({ abs: path.resolve(a), rel: r });
      }
    }
  };
  walk(dir, '');
  return { name: path.basename(path.resolve(dir)), dir: path.resolve(dir), main, files, skipped };
}

/** Other skills a skill calls (/name, .claude/skills/name, .claude/commands/name.md) that exist under root. */
export function relatedSkills(text, root, self) {
  const names = new Set();
  for (const m of text.matchAll(/(?:^|[\s`'"(])\/([a-z][\w-]{1,63})(?=[\s`'").,:;]|$)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/\.claude\/(?:skills|commands)\/([\w-]+)/g)) names.add(m[1]);
  const out = [];
  for (const n of names) {
    const file = [path.join(root, '.claude/skills', n, 'SKILL.md'), path.join(root, '.claude/commands', `${n}.md`)].find((f) => fs.existsSync(f));
    if (file && path.resolve(file) !== self) out.push({ name: n, abs: path.resolve(file) });
  }
  return out;
}

/** Problems of a finished package against Clateway's limits; empty when it imports as it is. Pure. */
export function checkPackage(json) {
  const L = PACKAGE_LIMITS;
  const problems = [];
  if (json?.format !== 'clateway-skill-package') return ['Not a Clateway skill package (format must be "clateway-skill-package")'];
  const todo = [];
  const visit = (v, at) => {
    if (typeof v === 'string' && /^TODO\b/.test(v)) todo.push(at);
    else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'content') visit(x, at ? `${at}.${k}` : k);
  };
  visit(json, '');
  if (todo.length) problems.push(`Still TODO (fill these in first): ${todo.join(', ')}`);
  if (!json.skill?.key || !/^[a-z][a-z0-9_]{1,63}$/.test(json.skill.key)) problems.push('skill.key must be snake_case (2–64 characters, starting with a letter)');
  if (!json.agent?.instructions) problems.push('agent.instructions is empty');
  else if (json.agent.instructions.length > L.instructions) problems.push(`agent.instructions is longer than ${L.instructions} characters`);
  const scripts = json.scripts ?? [], files = json.files ?? [];
  if (scripts.length > L.scripts) problems.push(`${scripts.length} scripts: at most ${L.scripts}`);
  if (files.length > L.files) problems.push(`${files.length} files: at most ${L.files}`);
  for (const s of scripts) if ((s.content ?? '').length > L.scriptB64) problems.push(`Script ${s.path} is larger than ~375 KB`);
  for (const f of files) if ((f.content ?? '').length > L.fileB64) problems.push(`File ${f.path} is larger than ~1.5 MB`);
  for (const x of [...scripts, ...files]) if (!x.content && !x.source) problems.push(`${x.path} has no content`);
  const total = [...scripts, ...files].reduce((n, x) => n + (x.content ?? '').length, 0);
  if (total > L.totalB64) problems.push(`Scripts and files together are larger than ~9 MB`);
  if (scripts.length && !scripts.some((s) => s.entrypoint)) problems.push('No script is marked "entrypoint": true');
  if ((json.memory_seeds ?? []).length > L.memorySeeds) problems.push(`More than ${L.memorySeeds} memory_seeds`);
  for (const s of json.secrets_needed ?? []) if (s.value !== undefined) problems.push(`secrets_needed ${s.name} holds a value: names only`);
  if (!(json.evals ?? []).length) problems.push('No evals: add 1–3 small test tasks so "Test in a sandbox" can prove it runs');
  return problems;
}

function parseArgs(argv) {
  const args = { target: null, pkg: null, out: null, root: null, scan: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') args.pkg = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--no-scan') args.scan = false;
    else if (!args.target) args.target = argv[i];
  }
  return args;
}

const posix = (p) => p.split(path.sep).join('/');

export function zipSkill({ target, pkg, out, root, scan = true }) {
  const projectRoot = path.resolve(root ?? process.cwd());
  const { name, dir, main, files, skipped } = collectSkill(target);
  const top = name.replace(/[^\w.-]+/g, '-') || 'skill';
  const warnings = [];
  const entries = [];
  const names = new Set();
  const add = (zipName, abs, label) => {
    if (names.has(zipName)) return false;
    const data = fs.readFileSync(abs);
    if (holdsSecret(data)) { skipped.push({ path: label, why: 'looks like it holds a key or token: move it to an environment variable' }); return false; }
    names.add(zipName);
    entries.push({ name: zipName, data });
    return true;
  };
  for (const f of files) add(`${top}/${f.rel}`, f.abs, f.rel);

  // Everything the skill uses from outside its folder, at its project path.
  const fromProject = [];
  let scanSummary = null;
  if (scan) {
    const report = scanSkill(main, { root: projectRoot });
    const inside = (abs) => (dir ? abs === dir || abs.startsWith(dir + path.sep) : abs === main);
    for (const f of [...report.scripts, ...report.files]) {
      const abs = path.resolve(projectRoot, f.path);
      if (inside(abs) || SECRET_FILES.test(path.basename(abs))) continue;
      if (add(`${top}/${f.path}`, abs, f.path)) fromProject.push(f.path);
    }
    scanSummary = {
      sandbox_ok: report.sandbox.ok, image: report.sandbox.image, missing_tools: report.sandbox.missing_tools,
      local_paths: report.local_paths, missing_files: report.missing_files, env_vars: report.env_vars, hosts: report.hosts,
    };
    if (!report.sandbox.ok) warnings.push('The scan found local paths, missing files or programs the sandbox lacks (see scan): fix them first, or the agent fails in the sandbox.');
    for (const s of report.skipped) warnings.push(`Not packed: ${s}`);
  }

  // Other skills it calls, as reference text.
  const related = [];
  for (const r of relatedSkills(fs.readFileSync(main, 'utf8'), projectRoot, main)) {
    if (add(`${top}/references/${r.name}.md`, r.abs, posix(path.relative(projectRoot, r.abs)))) related.push(r.name);
  }

  let packageProblems = [];
  if (pkg) {
    const text = fs.readFileSync(pkg, 'utf8');
    const json = JSON.parse(text);
    if (json.format !== 'clateway-skill-package') throw new Error(`${pkg} is not a Clateway skill package`);
    packageProblems = checkPackage(json);
    if (packageProblems.length) throw new Error(`The package cannot be imported as it is:\n- ${packageProblems.join('\n- ')}`);
    entries.push({ name: `${top}/${top}.clateway-skill.json`, data: Buffer.from(text, 'utf8') });
  } else {
    // Without a package Clateway builds one from the folder: same limits.
    const scripts = entries.filter((e) => /\.(py|sh|bash|js|mjs|cjs|ts)$/i.test(e.name)).length;
    const other = entries.length - scripts - entries.filter((e) => e.name.endsWith('.md')).length;
    if (scripts > PACKAGE_LIMITS.scripts) warnings.push(`${scripts} scripts: Clateway keeps ${PACKAGE_LIMITS.scripts}. Add a finished package (--package) or trim.`);
    if (other > PACKAGE_LIMITS.files) warnings.push(`${other} data files: Clateway keeps ${PACKAGE_LIMITS.files}. Add a finished package (--package) or trim.`);
    warnings.push('No finished package inside: Clateway builds one from the folder (no memory rules, integrations or evals). /clateway-zip with --package gives a better agent.');
  }

  const zip = makeZip(entries);
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`The zip is ${(zip.length / 1048576).toFixed(1)} MB; Clateway reads up to 60 MB. Leave large data out.`);
  // Read it back: every entry present and byte for byte the same.
  const back = readZip(zip);
  for (const e of entries) if (!back[e.name] || !back[e.name].equals(e.data)) throw new Error(`Verification failed for ${e.name}`);
  const file = out ?? `${top}.zip`;
  fs.writeFileSync(file, zip);
  return {
    zip: path.resolve(file), bytes: zip.length, verified: true,
    files: entries.map((e) => e.name), with_package: !!pkg,
    added_from_project: fromProject, related_skills: related,
    scan: scanSummary, skipped, warnings,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('zip-skill.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error('Usage: node zip-skill.mjs <skill folder | SKILL.md | command .md> [--root .] [--package pkg.json] [--out skill.zip] [--no-scan]');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(zipSkill(args), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
