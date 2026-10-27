#!/usr/bin/env node
/**
 * Packs a Claude Code skill folder into a zip for Clateway's "Import from Claude Code" upload
 * (Hire an agent, or admin → Advanced agents → Import). Clateway reads the SKILL.md, scripts and
 * files in the zip; when the zip also holds a .clateway-skill.json (made by /clateway-zip or
 * /clateway-export) that package is used as it is.
 *
 *   node zip-skill.mjs <skill folder | SKILL.md | command .md> [--package pkg.json] [--out skill.zip]
 *
 * Leaves out what never belongs in a package: secrets (.env, keys), dependencies and caches
 * (node_modules, __pycache__, .git, …). Prints a JSON report. Node 20+, no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '__MACOSX', '.idea', '.vscode']);
const SKIP_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.pyc|.*\.log|.*\.zip)$/i;
const SECRET_FILES = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials(\.json)?)$/i;
/** Clateway reads at most this much from a zip. */
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;

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

// ── the skill folder ─────────────────────────────────────────────────────────

/** The files of a skill folder to pack, and what was left out (with why). */
export function collectSkill(target) {
  const stat = fs.statSync(target);
  const single = stat.isFile();
  const dir = single && path.basename(target).toLowerCase() !== 'skill.md' ? null : single ? path.dirname(target) : target;
  const files = [];
  const skipped = [];
  if (!dir) {
    files.push({ abs: target, rel: path.basename(target) });
    return { name: path.basename(target, '.md'), files, skipped };
  }
  if (!fs.existsSync(path.join(dir, 'SKILL.md')) && !fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md'))) {
    throw new Error(`No SKILL.md (or other .md) in ${dir}`);
  }
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
        files.push({ abs: a, rel: r });
      }
    }
  };
  walk(dir, '');
  return { name: path.basename(path.resolve(dir)), files, skipped };
}

function parseArgs(argv) {
  const args = { target: null, pkg: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') args.pkg = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (!args.target) args.target = argv[i];
  }
  return args;
}

export function zipSkill({ target, pkg, out }) {
  const { name, files, skipped } = collectSkill(target);
  const top = name.replace(/[^\w.-]+/g, '-') || 'skill';
  const entries = files.map((f) => ({ name: `${top}/${f.rel}`, data: fs.readFileSync(f.abs) }));
  if (pkg) {
    const text = fs.readFileSync(pkg, 'utf8');
    const json = JSON.parse(text);
    if (json.format !== 'clateway-skill-package') throw new Error(`${pkg} is not a Clateway skill package`);
    entries.push({ name: `${top}/${top}.clateway-skill.json`, data: Buffer.from(text, 'utf8') });
  }
  const zip = makeZip(entries);
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`The zip is ${(zip.length / 1048576).toFixed(1)} MB; Clateway reads up to 60 MB. Leave large data out.`);
  const file = out ?? `${top}.zip`;
  fs.writeFileSync(file, zip);
  return { zip: path.resolve(file), bytes: zip.length, files: entries.map((e) => e.name), with_package: !!pkg, skipped };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('zip-skill.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error('Usage: node zip-skill.mjs <skill folder | SKILL.md> [--package pkg.json] [--out skill.zip]');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(zipSkill(args), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
