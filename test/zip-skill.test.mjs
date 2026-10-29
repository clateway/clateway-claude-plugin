// The plugin's skill zipper (clateway/scripts/zip-skill.mjs). Run: npm test
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPackage, collectSkill, holdsSecret, makeZip, readZip, relatedSkills, zipSkill } from '../clateway/scripts/zip-skill.mjs';

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

function goodPackage() {
  return {
    format: 'clateway-skill-package', version: '1.0',
    skill: { key: 'company_gif', name: 'Company GIF', description: 'GIF' },
    agent: { name: 'Gif', roleTitle: 'GIF maker', mission: 'GIFs', instructions: 'Run scripts/render.py' },
    scripts: [{ path: 'scripts/render.py', runtime: 'python', entrypoint: true, content: 'cHJpbnQoMSk=' }],
    evals: [{ task: 'Make a GIF', expect_files: ['.gif'] }],
  };
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
    writeFileSync(pkg, JSON.stringify(goodPackage()));
    const out = join(root, 'out.zip');
    const r = zipSkill({ target: dir, pkg, out, root, scan: false });
    assert.equal(r.with_package, true);
    const back = readZip(readFileSync(out));
    assert.ok(back['company-gif/company-gif.clateway-skill.json']);
    assert.ok(back['company-gif/scripts/render.py']);
    assert.ok(!Object.keys(back).some((n) => n.includes('.env') || n.includes('node_modules')));
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{"x":1}');
    assert.throws(() => zipSkill({ target: dir, pkg: bad, out, root, scan: false }), /not a Clateway skill package/);
    writeFileSync(bad, JSON.stringify({ ...goodPackage(), agent: { name: 'TODO', instructions: 'x' } }));
    assert.throws(() => zipSkill({ target: dir, pkg: bad, out, root, scan: false }), /Still TODO.*agent\.name/);
  });

  it('packs a single command file as it is', () => {
    const { root } = skillFolder();
    const md = join(root, 'weekly.md');
    writeFileSync(md, '# Weekly\nDo it');
    const r = zipSkill({ target: md, out: join(root, 'w.zip'), root });
    assert.deepEqual(r.files, ['weekly/weekly.md']);
  });

  it('adds the scripts and files it uses from elsewhere in the project, and skills it calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'zip-project-'));
    const put = (p, c) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); };
    put('.claude/skills/deck/SKILL.md', '# Deck\nRun `node scripts/demo/make-deck.mjs`, then /brand-check.');
    put('scripts/demo/make-deck.mjs', "import { x } from './lib.mjs';\nconst t = JSON.parse(fs.readFileSync('assets/theme.json'));");
    put('scripts/demo/lib.mjs', 'export const x = 1;');
    put('assets/theme.json', '{}');
    put('.claude/commands/brand-check.md', '# Brand check');
    put('scripts/demo/leak.json', '{"k":"sk-ant-abcdefghijklmnopqrstuvwxyz0123"}');
    const r = zipSkill({ target: join(root, '.claude/skills/deck'), out: join(root, 'deck.zip'), root });
    const back = readZip(readFileSync(r.zip));
    for (const n of ['deck/SKILL.md', 'deck/scripts/demo/make-deck.mjs', 'deck/scripts/demo/lib.mjs', 'deck/assets/theme.json', 'deck/references/brand-check.md']) assert.ok(back[n], n);
    assert.deepEqual(r.related_skills, ['brand-check']);
    assert.ok(r.verified);
    assert.ok(r.warnings.some((w) => /No finished package/.test(w)));
  });

  it('never packs a file holding a key', () => {
    assert.equal(holdsSecret(Buffer.from('token = "ghp_' + 'a'.repeat(36) + '"')), true);
    assert.equal(holdsSecret(Buffer.from('const key = process.env.OPENAI_API_KEY')), false);
    const { root, dir } = skillFolder();
    writeFileSync(join(dir, 'data/config.json'), '{"key":"AKIA' + 'ABCDEFGHIJKLMNOP' + '"}');
    const r = zipSkill({ target: dir, out: join(root, 'k.zip'), root, scan: false });
    assert.ok(!r.files.includes('company-gif/data/config.json'));
    assert.ok(r.skipped.some((s) => s.path === 'data/config.json'));
  });

  it('checks a package against the import limits', () => {
    assert.deepEqual(checkPackage(goodPackage()), []);
    const many = { ...goodPackage(), files: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt`, content: 'eA==' })) };
    assert.ok(checkPackage(many).some((p) => /21 files/.test(p)));
    assert.ok(checkPackage({ ...goodPackage(), evals: [] }).some((p) => /No evals/.test(p)));
    assert.ok(checkPackage({ ...goodPackage(), secrets_needed: [{ name: 'X', value: 'y' }] }).some((p) => /holds a value/.test(p)));
  });

  it('finds the skills a skill calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'zip-related-'));
    mkdirSync(join(root, '.claude/commands'), { recursive: true });
    writeFileSync(join(root, '.claude/commands/other.md'), '#');
    assert.deepEqual(relatedSkills('Then run /other and /missing.', root, '/x').map((r) => r.name), ['other']);
  });
});
