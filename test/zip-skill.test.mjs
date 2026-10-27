// The plugin's skill zipper (clateway/scripts/zip-skill.mjs). Run: npm test
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectSkill, crc32, makeZip, zipSkill } from '../clateway/scripts/zip-skill.mjs';

/** Reads a zip back (central directory, then each entry), as Clateway's upload does with JSZip. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
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
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

function skillFolder() {
  const root = mkdtempSync(join(tmpdir(), 'zip-skill-'));
  const dir = join(root, 'company-gif');
  const files = {
    'SKILL.md': '---\nname: company-gif\ndescription: GIF\n---\nRun scripts/render.py',
    'scripts/render.py': 'print("hi")\n'.repeat(200),
    'data/template.json': '{"w": 800}',
    'fonts/x.ttf': '\u0000\u0001',
    '.env': 'OPENAI_API_KEY=sk-secret',
    'node_modules/a/index.js': 'x',
    '.DS_Store': 'x',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return { root, dir };
}

describe('zip-skill', () => {
  it('writes a zip that reads back byte for byte', () => {
    const entries = [{ name: 'a/x.txt', data: Buffer.from('hello '.repeat(100)) }, { name: 'a/é.bin', data: Buffer.from([0, 1, 2]) }];
    const back = readZip(makeZip(entries));
    assert.deepEqual(Object.keys(back), ['a/x.txt', 'a/é.bin']);
    assert.equal(back['a/x.txt'].toString(), 'hello '.repeat(100));
    assert.deepEqual([...back['a/é.bin']], [0, 1, 2]);
  });

  it('packs the skill folder without secrets, dependencies or caches', () => {
    const { dir } = skillFolder();
    const c = collectSkill(dir);
    assert.equal(c.name, 'company-gif');
    assert.deepEqual(c.files.map((f) => f.rel).sort(), ['SKILL.md', 'data/template.json', 'fonts/x.ttf', 'scripts/render.py']);
    assert.ok(c.skipped.some((s) => s.path === '.env' && /secret/.test(s.why)));
    assert.ok(c.skipped.some((s) => s.path === 'node_modules/'));
    // SKILL.md itself as the target means its folder.
    assert.equal(collectSkill(join(dir, 'SKILL.md')).files.length, 4);
  });

  it('adds the package next to the files when given', () => {
    const { root, dir } = skillFolder();
    const pkg = join(root, 'pkg.json');
    writeFileSync(pkg, JSON.stringify({ format: 'clateway-skill-package', version: '1.0' }));
    const out = join(root, 'out.zip');
    const r = zipSkill({ target: dir, pkg, out });
    assert.equal(r.with_package, true);
    const back = readZip(readFileSync(out));
    assert.ok(back['company-gif/company-gif.clateway-skill.json']);
    assert.ok(back['company-gif/scripts/render.py']);
    assert.ok(!Object.keys(back).some((n) => n.includes('.env') || n.includes('node_modules')));
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{"x":1}');
    assert.throws(() => zipSkill({ target: dir, pkg: bad, out }), /not a Clateway skill package/);
  });

  it('packs a single command file as it is', () => {
    const { root } = skillFolder();
    const md = join(root, 'weekly.md');
    writeFileSync(md, '# Weekly\nDo it');
    const r = zipSkill({ target: md, out: join(root, 'w.zip') });
    assert.deepEqual(r.files, ['weekly/weekly.md']);
  });
});
