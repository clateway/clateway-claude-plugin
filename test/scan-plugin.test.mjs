// The plugin scanner (clateway/scripts/scan-plugin.mjs): a whole plugin or project → a v2 agent package. Run: npm test
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPackage, findParts, hooksFrom, listOf, mcpServersFrom, mergeRequirements, modelTier, readFrontMatter, toKey, toSemver, varsIn,
} from '../clateway/scripts/scan-plugin.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = resolve(repo, '../clateway-insights50');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'scan-plugin-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('pieces', () => {
  it('reads front matter', () => {
    const { data, body } = readFrontMatter('---\nname: researcher\ndescription: "Finds accounts"\ntools: Read, WebFetch, mcp__crm__search\nmodel: opus\nskills:\n  - icp-scoring\n---\nDo the research.\n');
    assert.equal(data.name, 'researcher');
    assert.equal(data.description, 'Finds accounts');
    assert.deepEqual(listOf(data.tools), ['Read', 'WebFetch', 'mcp__crm__search']);
    assert.deepEqual(data.skills, ['icp-scoring']);
    assert.equal(body, 'Do the research.\n');
    assert.deepEqual(readFrontMatter('no front matter').data, {});
    assert.deepEqual(readFrontMatter('---\ntools: [Read, Bash]\n---\n').data.tools, ['Read', 'Bash']);
  });

  it('maps keys, versions and models', () => {
    assert.equal(toKey('Sales Team — EU'), 'sales_team_eu');
    assert.equal(toKey('9', 'x'), 'x');
    assert.equal(toSemver('1.2'), '1.2.0');
    assert.equal(toSemver('v2.0.1'), '2.0.1');
    assert.equal(toSemver(''), '1.0.0');
    assert.equal(modelTier('opus'), 'demanding');
    assert.equal(modelTier('claude-haiku-5-5'), 'routine');
    assert.equal(modelTier('sonnet'), 'standard');
    assert.equal(modelTier('inherit'), null);
  });

  it('reads MCP servers without copying values', () => {
    const r = mcpServersFrom({
      mcpServers: {
        crm: { type: 'http', url: 'https://mcp.crm.example.org/mcp', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } },
        notes: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/notes.js'], env: { NOTES_DIR: '${CLAUDE_PLUGIN_ROOT}/data', API_KEY: 'sk-live-123' } },
        plain: { type: 'sse', url: 'http://localhost:3000' },
      },
    });
    assert.deepEqual(r.servers.map((s) => [s.key, s.transport]), [['crm', 'http'], ['notes', 'stdio'], ['plain', 'http']]);
    assert.deepEqual(r.secrets.map((s) => s.name), ['CRM_TOKEN', 'API_KEY']);
    assert.deepEqual(r.secrets[0].domains, ['mcp.crm.example.org']);
    assert.ok(!JSON.stringify(r).includes('sk-live-123'));
    assert.ok(r.warnings.some((w) => /literal value for API_KEY/.test(w)));
    assert.ok(r.warnings.some((w) => /not on https/.test(w)));
    assert.deepEqual(varsIn('${CLAUDE_PLUGIN_ROOT}/x ${TOKEN:-none} $OTHER'), ['TOKEN', 'OTHER']);
  });

  it('lists hooks as not translated', () => {
    const out = hooksFrom({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, 'hooks/hooks.json');
    assert.equal(out.length, 2);
    assert.match(out[0].item, /PreToolUse:Bash → \.\/guard\.sh/);
    assert.match(out[0].reason, /agent policy/);
  });

  it('merges requirements', () => {
    assert.deepEqual(mergeRequirements([
      { sandbox_profile: 'data-python', network: 'none', domains: [], tools: ['python3'], node_packages: [], python_packages: ['pandas'] },
      { sandbox_profile: 'media', network: 'allowlist', domains: ['api.x.com'], tools: ['ffmpeg'], node_packages: ['sharp'], python_packages: [] },
    ]), { sandbox_profile: 'media', network: 'allowlist', domains: ['api.x.com'], tools: ['ffmpeg', 'python3'], node_packages: ['sharp'], python_packages: ['pandas'] });
    assert.equal(mergeRequirements([]), undefined);
  });
});

describe('a plugin with skills, subagents, an MCP server and hooks', () => {
  const root = project({
    '.claude-plugin/plugin.json': { name: 'sales-team', version: '1.2', description: 'Researches accounts and writes proposals.', author: { name: 'Acme' } },
    'skills/icp-scoring/SKILL.md': '---\nname: icp-scoring\ndescription: Score an account against the ICP\nallowed-tools: Read, Bash\n---\nRun `node scripts/score.mjs <company>` and report the score.\n',
    'skills/icp-scoring/scripts/score.mjs': "import fs from 'node:fs';\nconsole.log(process.env.SCORING_KEY ? 1 : 0);\n",
    'commands/brief.md': '---\ndescription: Write an account brief\nargument-hint: <company>\n---\nWrite a brief for $ARGUMENTS.\n',
    'agents/researcher.md': '---\nname: researcher\ndescription: Researches the account and its people.\ntools: Read, WebFetch, mcp__crm__search\nmodel: opus\nskills: [icp-scoring]\n---\nResearch the account in depth.\n',
    'agents/writer.md': '---\nname: writer\ndescription: Writes the proposal.\nmodel: haiku\n---\nWrite the proposal.\n',
    '.mcp.json': { mcpServers: { crm: { type: 'http', url: 'https://mcp.crm.example.org/mcp', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } }, notes: { command: 'node', args: ['mcp/notes.js'] } } },
    'hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh' }] }] } },
  });
  const { pkg, report } = buildPackage(findParts(root), { root: join(root, 'skills/icp-scoring') });

  it('is a team with a lead that delegates', () => {
    assert.equal(pkg.format, 'clateway-agent-package');
    assert.equal(pkg.version, '2.0');
    assert.deepEqual(pkg.package, {
      key: 'sales_team', version: '1.2.0', name: 'Sales Team', description: 'Researches accounts and writes proposals.',
      author: { name: 'Acme', url: undefined }, source: { kind: 'claude_plugin', path: '../..' },
    });
    assert.deepEqual(pkg.team, { name: 'Sales Team', lead: 'lead', members: ['lead', 'researcher', 'writer'] });
    const [lead, researcher, writer] = pkg.agents;
    assert.deepEqual(lead.subagents, ['researcher', 'writer']);
    assert.deepEqual(lead.skills, ['custom:icp_scoring', 'custom:cmd_brief']);
    assert.deepEqual(lead.mcp, ['crm', 'notes']);
    assert.deepEqual(lead.tools, { allowed: ['Bash', 'Read'] });
    assert.match(lead.instructions, /Delegate a part of the work/);
    assert.match(lead.instructions, /\*\*Researcher\*\* \(researcher\)/);
    assert.deepEqual(lead.tasks, { default: 'Write an account brief (<company>)', examples: ['Write an account brief (<company>)'] });
    assert.deepEqual(researcher.model, { tier: 'demanding' });
    assert.deepEqual(researcher.mcp, ['crm']);
    assert.deepEqual(researcher.skills, ['custom:icp_scoring']);
    assert.deepEqual(researcher.tools, { allowed: ['Read', 'WebFetch', 'mcp__crm__search'] });
    assert.equal(researcher.instructions, 'Research the account in depth.');
    assert.deepEqual(writer.model, { tier: 'routine' });
  });

  it('carries the skills, scripts, servers, secrets and what is not translated', () => {
    assert.deepEqual(pkg.skills.map((s) => [s.key, s.name]), [['icp_scoring', 'icp-scoring'], ['cmd_brief', '/brief']]);
    assert.match(pkg.skills[0].instructions, /node scripts\/score\.mjs/);
    assert.deepEqual(pkg.scripts.map((s) => s.path), ['scripts/score.mjs']);
    assert.deepEqual(pkg.mcp_servers, [{ key: 'crm', transport: 'http', url: 'https://mcp.crm.example.org/mcp' }, { key: 'notes', transport: 'stdio', command: 'node', args: ['mcp/notes.js'] }]);
    assert.deepEqual(pkg.secrets_needed.map((s) => s.name).sort(), ['CRM_TOKEN', 'SCORING_KEY']);
    const nt = pkg.not_translated.map((n) => n.item).join('\n');
    assert.match(nt, /hook PreToolUse:Bash/);
    assert.match(nt, /MCP server notes \(node mcp\/notes\.js\)/);
    assert.deepEqual(report.agents, ['lead', 'researcher', 'writer']);
    assert.equal(report.team, true);
  });
});

describe('a single skill and a project folder', () => {
  it('a SKILL.md becomes one agent without a team', () => {
    const root = project({ 'my-skill/SKILL.md': '---\nname: company-gif\ndescription: Makes a GIF\n---\nMake the GIF.\n' });
    const { pkg } = buildPackage(findParts(join(root, 'my-skill/SKILL.md')), { root });
    assert.equal(pkg.team, undefined);
    assert.equal(pkg.agents.length, 1);
    assert.equal(pkg.agents[0].key, 'company_gif');
    assert.deepEqual(pkg.agents[0].skills, ['custom:company_gif']);
    assert.equal(pkg.package.source.kind, 'skill');
  });

  it('a project .claude folder with agents and settings hooks', () => {
    const root = project({
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews code\n---\nReview.\n',
      '.claude/commands/review.md': 'Review the diff.\n',
      '.claude/settings.json': { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } },
    });
    const parts = findParts(root);
    assert.equal(parts.kind, 'skill');
    const { pkg } = buildPackage(parts, { root, key: 'review_team' });
    assert.equal(pkg.package.key, 'review_team');
    assert.deepEqual(pkg.agents.map((a) => a.key), ['lead', 'reviewer']);
    assert.match(pkg.not_translated[0].item, /PostToolUse:Edit → npm run lint/);
  });

  it('refuses a folder without a plugin, .claude or SKILL.md', () => {
    assert.throws(() => findParts(project({ 'README.md': 'x' })), /No Claude Code plugin/);
  });
});

describe('against the platform', { skip: !existsSync(join(platform, 'supabase/functions/_shared/ai-workforce/agent-package.ts')) && 'platform repository not next to this one' }, () => {
  it('the platform validator accepts the package', async () => {
    const root = project({
      '.claude-plugin/plugin.json': { name: 'sales-team', version: '1.0.0', description: 'Sales work.' },
      'skills/brief/SKILL.md': '---\nname: brief\ndescription: Account brief\n---\nWrite the brief.\n',
      'agents/researcher.md': '---\nname: researcher\ndescription: Researches.\n---\nResearch.\n',
      '.mcp.json': { mcpServers: { crm: { type: 'http', url: 'https://mcp.crm.example.org/mcp' } } },
    });
    const { pkg } = buildPackage(findParts(root), { root });
    // Node 22.6+ runs the platform's TypeScript with type stripping; older Node skips.
    let mod;
    try { mod = await import(join(platform, 'supabase/functions/_shared/ai-workforce/agent-package.ts')); } catch { return; }
    const r = mod.validateAgentPackage(pkg);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});
