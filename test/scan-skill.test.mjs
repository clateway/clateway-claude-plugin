// The plugin's skill scanner (clateway/scripts/scan-skill.mjs). Run: npm test
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { binariesIn, codeBlocks, envVarsIn, hostsIn, jsImports, loadSandbox, packageSkeleton, pyImports, scanSkill } from '../clateway/scripts/scan-skill.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Clateway's platform repository next to this one (sandbox image, /company-gif skill): maintainers only, skipped otherwise.
const platform = resolve(repo, '../clateway-insights50');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'scan-skill-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

describe('pieces', () => {
  it('reads imports, programs, variables and hosts', () => {
    assert.deepEqual(jsImports(`import { chromium } from 'playwright'; import x from './lib.mjs'; const fs = require('node:fs'); require('<project>/node_modules/sharp/lib/index.js'); import('@scope/pkg/sub')`),
      { relative: ['./lib.mjs'], packages: ['playwright', '@scope/pkg', 'sharp'] });
    assert.deepEqual(pyImports('import os, requests\nfrom PIL import Image\nfrom .util import x'), { modules: ['os', 'requests', 'PIL'], relative: ['.util'] });
    assert.deepEqual(binariesIn("spawnSync('gifski', args); execSync('ffmpeg -i a b'); await $`magick a b`", 'node'), ['gifski', 'ffmpeg', 'magick']);
    assert.deepEqual(binariesIn('subprocess.run(["pandoc", "-o", "x"])\nos.system("soffice --headless")', 'python'), ['pandoc', 'soffice']);
    assert.deepEqual(binariesIn('set -e\nif true; then\n  gifski --fps 12 -o out.gif *.png && echo done\nfi', 'bash'), ['gifski']);
    assert.deepEqual(envVarsIn('process.env.OPENAI_API_KEY; process.env.HOME', 'node'), ['OPENAI_API_KEY']);
    assert.deepEqual(envVarsIn('os.environ.get("TOKEN")', 'python'), ['TOKEN']);
    assert.deepEqual(hostsIn('fetch("https://api.openai.com/v1/x"); see https://example.com'), ['api.openai.com']);
    assert.deepEqual(hostsIn('Loads the Epilogue font from Google Fonts'), ['fonts.googleapis.com', 'fonts.gstatic.com']);
    assert.deepEqual(codeBlocks('```js\nimport x from "y"\n```\n```text\nno\n```').map((b) => b.kind), ['node']);
  });
});

describe('a skill with scripts', () => {
  const root = project({
    '.claude/commands/report.md': 'Run `node scripts/report/build.mjs` and `python3 tools/chart.py`. Needs `brew install pandoc`.',
    'scripts/report/build.mjs': "import { Document } from 'docx';\nimport { helper } from '../lib/helper.mjs';\nimport left from 'left-pad';\nconst cfg = readFileSync('config/report.json');\nconst key = process.env.NOTION_TOKEN;\nawait fetch('https://api.notion.com/v1/pages');\nconst tpl = '/Users/pascal/templates/report.html';",
    'scripts/lib/helper.mjs': "export const helper = 1; execSync('weird-tool --x');",
    'tools/chart.py': 'import matplotlib\nimport rich\n',
    'config/report.json': '{}',
    'package.json': JSON.stringify({ dependencies: { docx: '^9.0.0', 'left-pad': '^1.3.0' } }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/left-pad': { version: '1.3.0' }, 'node_modules/docx': { version: '9.1.0' } } }),
    'requirements.txt': 'rich==13.9.2\n',
  });
  const report = scanSkill(join(root, '.claude/commands/report.md'), { root });

  it('follows the scripts and the files they read', () => {
    assert.deepEqual(report.scripts.map((s) => s.path), ['scripts/report/build.mjs', 'tools/chart.py', 'scripts/lib/helper.mjs']);
    assert.equal(report.scripts[0].entrypoint, true);
    assert.deepEqual(report.files.map((f) => f.path), ['config/report.json']);
  });
  it('lists packages with lockfile versions and what the sandbox must install', () => {
    assert.deepEqual(report.packages.npm, { docx: '9.1.0', 'left-pad': '1.3.0' });
    assert.deepEqual(report.packages.pip, { matplotlib: '', rich: '==13.9.2' });
    assert.deepEqual(report.sandbox.npm_to_install, ['left-pad']);
    assert.deepEqual(report.sandbox.pip_to_install, ['rich']);
    assert.ok(report.requirements.node_packages.includes('left-pad@1.3.0'));
  });
  it('finds programs, secrets, hosts and local-only paths', () => {
    assert.deepEqual(report.binaries, ['pandoc', 'weird-tool']);
    assert.deepEqual(report.sandbox.missing_tools, ['weird-tool']);
    assert.equal(report.sandbox.image, 'standard');
    assert.deepEqual(report.secrets_needed, [{ name: 'NOTION_TOKEN', description: '', domains: [], required: true }]);
    assert.deepEqual(report.hosts, ['api.notion.com']);
    assert.equal(report.requirements.network, 'allowlist');
    assert.deepEqual(report.requirements.domains, ['api.notion.com']);
    assert.deepEqual(report.local_paths, [{ file: 'scripts/report/build.mjs', line: 7, value: '/Users/pascal/templates/report.html' }]);
    assert.equal(report.sandbox.ok, false);
  });
  it('writes a package skeleton that keeps the project layout in /workspace', () => {
    const p = packageSkeleton(report, root, 'report');
    assert.deepEqual(p.scripts.map((s) => s.path), ['scripts/report/build.mjs', 'scripts/lib/helper.mjs']);
    assert.deepEqual(p.files.map((f) => f.path), ['tools/chart.py', 'config/report.json']);
    assert.equal(Buffer.from(p.files[1].content, 'base64').toString(), '{}');
    assert.equal(p.secrets_needed[0].name, 'NOTION_TOKEN');
  });
});

describe('LibreOffice', () => {
  it('is only in the full sandbox image', () => {
    const root = project({ '.claude/commands/doc.md': 'Convert it:\n\n```bash\nsoffice --headless --convert-to pdf in.docx\n```\n' });
    const report = scanSkill(join(root, '.claude/commands/doc.md'), { root });
    assert.equal(report.sandbox.image, 'full');
    assert.deepEqual(report.sandbox.missing_tools, []);
    assert.ok(report.warnings.some((w) => /full sandbox image/.test(w)));
    assert.ok(loadSandbox().officeTools.has('soffice'));
    assert.ok(!loadSandbox().tools.has('soffice'));
  });
});

describe('plugin files', () => {
  it('are one marketplace at the repository root with the clateway plugin', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'clateway/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'clateway');
    const market = JSON.parse(readFileSync(join(repo, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(market.name, 'clateway');
    assert.equal(market.plugins[0].name, 'clateway');
    assert.equal(market.plugins[0].source, './clateway');
  });
  it('ship the same package list as the sandbox image (when the platform repository is next to this one)', { skip: !existsSync(platform) }, () => {
    assert.equal(readFileSync(join(repo, 'clateway/scripts/sandbox-packages.json'), 'utf8'),
      readFileSync(join(platform, 'agentcore/workspace/sandbox-packages.json'), 'utf8'));
  });
});

describe('the /company-gif skill of the platform repository', { skip: !existsSync(join(platform, '.claude/commands/company-gif.md')) }, () => {
  it('finds the template file, Playwright, gifski, the font hosts and the local node_modules path', () => {
    const report = scanSkill(join(platform, '.claude/commands/company-gif.md'), { root: platform });
    assert.ok(report.files.map((f) => f.path).includes('src/components/marketing/PlatformStory.tsx'));
    assert.equal(report.requirements.sandbox_profile, 'media');
    assert.equal(report.requirements.network, 'allowlist');
    assert.deepEqual(report.requirements.node_packages, ['playwright']);
    assert.ok(['gifski', 'node'].every((t) => report.requirements.tools.includes(t)));
    assert.deepEqual(report.hosts, ['fonts.googleapis.com', 'fonts.gstatic.com']);
    assert.ok(report.local_paths[0].value.includes('<project>/node_modules/playwright'));
  });
});
