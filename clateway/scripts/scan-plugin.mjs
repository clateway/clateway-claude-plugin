#!/usr/bin/env node
/**
 * Clateway plugin scanner (Claude Code plugin "clateway", /clateway-export for a whole plugin or team).
 *
 * Reads a Claude Code plugin (a folder with .claude-plugin/plugin.json), a project's .claude folder or a single
 * SKILL.md and writes a Clateway agent package (format "clateway-agent-package" 2.0) without guessing:
 *
 *   - skills/<name>/SKILL.md and commands/<name>.md  → package skills (instructions in full)
 *   - agents/<name>.md (subagents)                    → agents of a team, with their tools and model tier
 *   - .mcp.json / plugin.json mcpServers              → mcp_servers (http or stdio; a local server's secrets as env names), secrets by name only
 *   - hooks (hooks/hooks.json, settings.json)         → listed under not_translated, never dropped silently
 *   - scripts and files the skills use                → scanned with scan-skill.mjs and merged
 *
 * With subagents the package is a team: a lead agent that delegates to them. Without them it is one agent.
 *
 *   node scan-plugin.mjs <plugin folder | project folder | SKILL.md> [--root <project>] [--package <out.json>] [--key <key>]
 *
 * Prints a report as JSON (counts, warnings, what is not translated). Node 18+, no dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSandbox, packageSkeleton, scanSkill } from './scan-skill.mjs';

export const AGENT_PACKAGE_FORMAT = 'clateway-agent-package';
export const AGENT_PACKAGE_VERSION = '2.0';
/** Clateway's limits (agent-package.ts / skill-package.ts on the platform). */
export const LIMITS = { agents: 12, skills: 40, mcpServers: 20, scripts: 60, files: 60, skillInstructions: 40_000, instructions: 100_000 };

const posix = (p) => p.split(sep).join('/');

/** A snake_case key Clateway accepts ("Sales Team" → "sales_team"). Pure. */
export function toKey(text, fallback = 'item') {
  let k = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '');
  if (k.length < 2) k = fallback;
  return k.slice(0, 64);
}

/** A version Clateway accepts (semver); "1.2" becomes "1.2.0". Pure. */
export function toSemver(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(s)) return s;
  const parts = s.match(/\d+/g) ?? [];
  if (!parts.length) return '1.0.0';
  return [...parts, '0', '0'].slice(0, 3).join('.');
}

/** Front matter of a markdown file (a small YAML subset: scalars, inline and dashed lists) and the body. Pure. */
export function readFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = /^\[.*\]$/.test(value.trim())
      ? value.trim().slice(1, -1).split(',').map((x) => unquote(x)).filter(Boolean)
      : unquote(value);
  }
  return { data, body: text.slice(m[0].length) };
}
const unquote = (s) => String(s).trim().replace(/^(['"])(.*)\1$/, '$2');

/** A list from a front matter value ("Read, Bash" or a list). Pure. */
export const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);

/** Claude model names → Clateway model tiers (never a model id). Pure. */
export function modelTier(model) {
  const m = String(model ?? '').toLowerCase();
  if (/opus/.test(m)) return 'demanding';
  if (/haiku/.test(m)) return 'routine';
  if (/sonnet/.test(m)) return 'standard';
  return null;
}

/** Variable names a config value refers to ("${API_KEY}", "$TOKEN"). Pure. */
export function varsIn(value) {
  const out = new Set();
  for (const m of String(value ?? '').matchAll(/\$\{?([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}?/g)) if (!NOT_SECRETS.has(m[1])) out.add(m[1]);
  return [...out];
}
/** Variables Claude Code fills in itself: never secrets. */
const NOT_SECRETS = new Set(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'HOME', 'PATH', 'PWD', 'USER', 'TMPDIR']);

/**
 * MCP servers of a config ({ mcpServers: { name: { type, url, command, args, env, headers } } }) as package
 * servers plus the secrets they need. Values are never copied: a literal header or env value is reported. Pure.
 */
export function mcpServersFrom(config, where = '.mcp.json') {
  const servers = [], secrets = [], warnings = [];
  const entries = Object.entries(config?.mcpServers ?? config ?? {});
  for (const [name, def] of entries) {
    if (!def || typeof def !== 'object') continue;
    const key = toKey(name, 'server');
    const http = /^(https?|sse|streamable-http|http)$/i.test(String(def.type ?? '')) || (!def.command && typeof def.url === 'string');
    const server = http
      ? { key, transport: 'http', url: String(def.url ?? '') }
      : { key, transport: 'stdio', command: String(def.command ?? ''), ...(Array.isArray(def.args) ? { args: def.args.map(String) } : {}) };
    if (http && !/^https:\/\//i.test(server.url)) warnings.push(`MCP server "${name}" (${where}) is not on https (${server.url || 'no url'}): Clateway only calls https servers`);
    servers.push(server);
    const named = new Set();
    // A local server reads its secrets from environment variables: the secret is named after the
    // variable it reads, and Clateway's workspace hands it over under that name (mcp_servers[].env).
    const envNames = new Set();
    for (const [k, v] of Object.entries(def.env ?? {})) {
      const refs = varsIn(v);
      if (refs.length) {
        if (http) refs.forEach((r) => named.add(r));
        else if (/^[A-Z][A-Z0-9_]{1,63}$/.test(k)) { named.add(k); envNames.add(k); }
      } else if (/\$\{?[A-Z_]/.test(String(v))) { /* only Claude Code's own variables */ }
      else {
        named.add(k);
        if (!http && /^[A-Z][A-Z0-9_]{1,63}$/.test(k)) envNames.add(k);
        warnings.push(`MCP server "${name}" has a literal value for ${k} in ${where}: it is not copied; enter it in Clateway as a secret`);
      }
    }
    if (!http && envNames.size) server.env = [...envNames];
    for (const [h, v] of Object.entries(def.headers ?? {})) {
      const refs = varsIn(v);
      if (refs.length) refs.forEach((r) => named.add(r));
      else if (/auth|key|token|secret/i.test(h)) { named.add(toKey(`${name}_${h}`).toUpperCase()); warnings.push(`MCP server "${name}" has a literal ${h} header in ${where}: it is not copied`); }
    }
    for (const n of named) secrets.push({ name: n, description: `Used by the MCP server "${name}"`, domains: http && /^https:\/\//i.test(server.url) ? [new URL(server.url).hostname] : [], required: true });
  }
  return { servers, secrets, warnings };
}

/** Hooks of a hooks config ({ hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }) as not-translated items. Pure. */
export function hooksFrom(config, where) {
  const out = [];
  for (const [event, groups] of Object.entries(config?.hooks ?? config ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const what = h.command ?? h.prompt ?? h.type ?? 'hook';
        out.push({
          item: `hook ${event}${g.matcher ? `:${g.matcher}` : ''} → ${String(what).slice(0, 120)} (${where})`,
          reason: event === 'PreToolUse'
            ? 'tool guards are not applied yet; ask a company admin for a matching agent policy (block a tool, always confirm)'
            : 'hooks are not run on Clateway; the agent works without this hook',
        });
      }
    }
  }
  return out;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const mdFiles = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f)) : []);
const skillFiles = (dir) => (existsSync(dir) && statSync(dir).isDirectory()
  ? readdirSync(dir).sort().map((d) => join(dir, d, 'SKILL.md')).filter((p) => existsSync(p))
  : []);
/** plugin.json paths: a string or a list, relative to the plugin. */
const extraPaths = (base, v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((p) => resolve(base, p));

/** What a folder or file holds: the plugin / project layout with its parts. */
export function findParts(target) {
  const abs = resolve(target);
  if (statSync(abs).isFile()) {
    return { kind: 'skill', base: dirname(abs), manifest: null, skills: [abs], commands: [], agents: [], mcp: [], hooks: [] };
  }
  const manifestPath = join(abs, '.claude-plugin', 'plugin.json');
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath) ?? {};
    const mcp = [join(abs, '.mcp.json'), ...(typeof manifest.mcpServers === 'string' ? [resolve(abs, manifest.mcpServers)] : [])].filter((p) => existsSync(p));
    return {
      kind: 'claude_plugin', base: abs, manifest,
      skills: [...skillFiles(join(abs, 'skills')), ...extraPaths(abs, manifest.skills).flatMap(skillFiles)],
      commands: [...mdFiles(join(abs, 'commands')), ...extraPaths(abs, manifest.commands).flatMap((p) => (p.endsWith('.md') ? [p] : mdFiles(p)))],
      agents: [...mdFiles(join(abs, 'agents')), ...extraPaths(abs, manifest.agents).flatMap((p) => (p.endsWith('.md') ? [p] : mdFiles(p)))],
      mcp, inlineMcp: typeof manifest.mcpServers === 'object' ? manifest.mcpServers : null,
      hooks: [join(abs, 'hooks', 'hooks.json'), ...(typeof manifest.hooks === 'string' ? [resolve(abs, manifest.hooks)] : [])].filter((p) => existsSync(p)),
      inlineHooks: typeof manifest.hooks === 'object' ? manifest.hooks : null,
    };
  }
  const dot = join(abs, '.claude');
  if (existsSync(dot)) {
    return {
      kind: 'skill', base: abs, manifest: null,
      skills: skillFiles(join(dot, 'skills')), commands: mdFiles(join(dot, 'commands')), agents: mdFiles(join(dot, 'agents')),
      mcp: [join(abs, '.mcp.json')].filter((p) => existsSync(p)),
      hooks: [join(dot, 'settings.json'), join(dot, 'settings.local.json')].filter((p) => existsSync(p)),
    };
  }
  if (existsSync(join(abs, 'SKILL.md'))) return findParts(join(abs, 'SKILL.md'));
  throw new Error(`No Claude Code plugin, .claude folder or SKILL.md in ${target}`);
}

/** Merges the requirements of several skill scans into one. Pure. */
export function mergeRequirements(list) {
  const reqs = list.filter(Boolean);
  if (!reqs.length) return undefined;
  const union = (k) => [...new Set(reqs.flatMap((r) => r[k] ?? []))].sort();
  const profiles = reqs.map((r) => r.sandbox_profile);
  const domains = union('domains');
  const nodePackages = union('node_packages'), pythonPackages = union('python_packages');
  const network = domains.length ? 'allowlist' : reqs.some((r) => r.network === 'registries') ? 'registries' : 'none';
  return {
    sandbox_profile: profiles.includes('media') ? 'media' : profiles.includes('full-stack') ? 'full-stack' : profiles[0] ?? 'full-stack',
    network, domains, tools: union('tools'), node_packages: nodePackages, python_packages: pythonPackages,
  };
}

/** A body without its "## Skill" wrapper noise; keeps the text as written. Pure. */
const cleanBody = (body) => body.replace(/^\s+|\s+$/g, '');

/** Builds the package from the parts. `scan` scans one skill / command file (tests replace it). */
export function buildPackage(parts, opts = {}) {
  const root = resolve(opts.root ?? parts.base);
  const scan = opts.scan ?? ((file) => scanSkill(file, { root, sandbox: opts.sandbox ?? loadSandbox() }));
  const warnings = [];
  const notTranslated = [];
  const manifest = parts.manifest ?? {};
  const name = manifest.name ?? (parts.kind === 'skill' && parts.skills.length === 1 ? readFrontMatter(readFileSync(parts.skills[0], 'utf8')).data.name : null) ?? basename(parts.base);
  const key = toKey(opts.key ?? name, 'package');

  // Skills and commands → package skills (commands are prompts, so they are skills with a task).
  const skills = [], taskExamples = [], skillKeys = new Set();
  const scans = [];
  const addSkill = (file, kind) => {
    const { data, body } = readFrontMatter(readFileSync(file, 'utf8'));
    const label = kind === 'command' ? basename(file, '.md') : data.name ?? basename(dirname(file));
    let k = toKey(`${kind === 'command' ? 'cmd_' : ''}${label}`, 'skill');
    while (skillKeys.has(k)) k = `${k}_2`.slice(0, 64);
    skillKeys.add(k);
    const instructions = cleanBody(body);
    if (instructions.length > LIMITS.skillInstructions) warnings.push(`${posix(relative(root, file))} is longer than ${LIMITS.skillInstructions} characters: shorten it or move reference text into files`);
    skills.push({ key: k, name: kind === 'command' ? `/${label}` : String(data.name ?? label), ...(data.description ? { description: String(data.description) } : {}), instructions: instructions.slice(0, LIMITS.skillInstructions) });
    if (kind === 'command') taskExamples.push(`${data.description ? String(data.description) : `Run /${label}`}${data['argument-hint'] ? ` (${data['argument-hint']})` : ''}`);
    const tools = listOf(data['allowed-tools']);
    try { scans.push({ file, report: scan(file) }); } catch (e) { warnings.push(`Could not scan ${posix(relative(root, file))}: ${e.message}`); }
    return { key: k, tools };
  };
  const skillRefs = [];
  const allowedTools = new Set();
  for (const f of parts.skills) { const s = addSkill(f, 'skill'); skillRefs.push(s.key); s.tools.forEach((t) => allowedTools.add(t)); }
  for (const f of parts.commands) { const s = addSkill(f, 'command'); skillRefs.push(s.key); s.tools.forEach((t) => allowedTools.add(t)); }

  // MCP servers and their secrets.
  const mcp = { servers: [], secrets: [], warnings: [] };
  const addMcp = (cfg, where) => { const r = mcpServersFrom(cfg, where); mcp.servers.push(...r.servers); mcp.secrets.push(...r.secrets); mcp.warnings.push(...r.warnings); };
  for (const p of parts.mcp ?? []) { const cfg = readJson(p); if (cfg) addMcp(cfg, posix(relative(root, p)) || '.mcp.json'); else warnings.push(`${p} is not valid JSON`); }
  if (parts.inlineMcp) addMcp(parts.inlineMcp, 'plugin.json');
  warnings.push(...mcp.warnings);
  const serverKeys = [...new Set(mcp.servers.map((s) => s.key))];
  const servers = serverKeys.map((k) => mcp.servers.find((s) => s.key === k));

  // Hooks are listed, never dropped silently.
  for (const p of parts.hooks ?? []) { const cfg = readJson(p); if (cfg?.hooks || (cfg && !Array.isArray(cfg) && parts.kind === 'claude_plugin')) notTranslated.push(...hooksFrom(cfg.hooks ?? cfg, posix(relative(root, p)))); }
  if (parts.inlineHooks) notTranslated.push(...hooksFrom(parts.inlineHooks.hooks ?? parts.inlineHooks, 'plugin.json'));

  // Subagents.
  const subagents = parts.agents.map((file) => {
    const { data, body } = readFrontMatter(readFileSync(file, 'utf8'));
    const label = String(data.name ?? basename(file, '.md'));
    const tools = listOf(data.tools);
    const mcpUsed = serverKeys.filter((k) => tools.some((t) => t.startsWith(`mcp__${k}__`) || t === `mcp__${k}`));
    const tier = modelTier(data.model);
    const agentSkills = listOf(data.skills).map((s) => toKey(s)).filter((s) => skillKeys.has(s)).map((s) => `custom:${s}`);
    return {
      key: toKey(label, 'agent'), name: label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      roleTitle: String(data.role ?? data.description ?? label).split(/[.\n]/)[0].slice(0, 120) || label,
      mission: String(data.description ?? `Does the ${label} part of the work.`),
      instructions: cleanBody(body) || String(data.description ?? label),
      ...(agentSkills.length ? { skills: agentSkills } : {}),
      ...(tools.length ? { tools: { allowed: tools } } : {}),
      ...(mcpUsed.length ? { mcp: mcpUsed } : {}),
      ...(tier ? { model: { tier } } : {}),
    };
  });
  const seenAgents = new Set();
  for (const a of subagents) { while (seenAgents.has(a.key)) a.key = `${a.key}_2`.slice(0, 64); seenAgents.add(a.key); }

  // The lead: the one who gets the task, holds the skills and delegates to the subagents.
  const title = String(manifest.displayName ?? name).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const description = String(manifest.description ?? (parts.skills[0] ? readFrontMatter(readFileSync(parts.skills[0], 'utf8')).data.description ?? '' : '') ?? '');
  const delegation = subagents.length
    ? `\n\n## Your team\n\nDelegate a part of the work to the colleague whose description fits, and combine their results in your report. If a colleague is not on your team on Clateway, do that part yourself.\n\n${subagents.map((a) => `- **${a.name}** (${a.key}): ${a.mission}`).join('\n')}`
    : '';
  const skillList = skills.length ? `\n\n## Your skills\n\nFollow the skill that fits the task:\n\n${skills.map((s) => `- **${s.name}**${s.description ? `: ${s.description}` : ''}`).join('\n')}` : '';
  const lead = {
    key: subagents.length ? 'lead' : key,
    name: subagents.length ? `${title} lead` : title,
    roleTitle: subagents.length ? `Lead of ${title}` : title,
    mission: description || `Does the work of ${title}.`,
    instructions: `${description || `You do the work of ${title}.`} Work on your own: propose changes and wait for the person's approval instead of asking them questions mid-task.${skillList}${delegation}`.slice(0, LIMITS.instructions),
    ...(skillRefs.length ? { skills: skillRefs.map((k) => `custom:${k}`) } : {}),
    ...(allowedTools.size ? { tools: { allowed: [...allowedTools].sort() } } : {}),
    ...(serverKeys.length ? { mcp: serverKeys } : {}),
    ...(subagents.length ? { subagents: subagents.map((a) => a.key) } : {}),
    tasks: { ...(taskExamples[0] ? { default: taskExamples[0] } : {}), examples: taskExamples.slice(0, 10) },
  };
  if (subagents.some((a) => a.key === lead.key)) lead.key = 'team_lead';
  const agents = [lead, ...subagents];

  // Scripts, files, requirements and secrets of every skill, merged once.
  const scripts = new Map(), files = new Map();
  for (const { report } of scans) {
    const sk = packageSkeleton(report, root, key);
    for (const s of sk.scripts) scripts.set(s.path, s);
    for (const f of sk.files) files.set(f.path, f);
    warnings.push(...report.warnings.map((w) => `${report.skill}: ${w}`));
    if (report.local_paths.length) warnings.push(`${report.skill}: ${report.local_paths.length} path(s) that only exist on this machine`);
  }
  if (scripts.size > LIMITS.scripts) warnings.push(`${scripts.size} scripts: Clateway takes at most ${LIMITS.scripts}`);
  if (files.size > LIMITS.files) warnings.push(`${files.size} files: Clateway takes at most ${LIMITS.files}`);
  if (agents.length > LIMITS.agents) warnings.push(`${agents.length} agents: Clateway takes at most ${LIMITS.agents} per team`);
  if (skills.length > LIMITS.skills) warnings.push(`${skills.length} skills: Clateway takes at most ${LIMITS.skills}`);
  if (servers.length > LIMITS.mcpServers) warnings.push(`${servers.length} MCP servers: Clateway takes at most ${LIMITS.mcpServers}`);
  const requirements = mergeRequirements(scans.map((s) => s.report.requirements));
  const secretByName = new Map();
  for (const s of [...scans.flatMap((x) => x.report.secrets_needed ?? []), ...mcp.secrets]) {
    const prev = secretByName.get(s.name);
    secretByName.set(s.name, prev ? { ...prev, domains: [...new Set([...(prev.domains ?? []), ...(s.domains ?? [])])], description: prev.description || s.description } : s);
  }
  for (const s of servers.filter((x) => x.transport === 'stdio')) {
    warnings.push(`Local MCP server "${s.key}" (${[s.command, ...(s.args ?? [])].join(' ')}) runs in the agent's sandbox behind the Clateway MCP proxy: list the hosts it calls as mcp_servers[].hosts, or its tools that change something outside the sandbox are not run`);
  }

  const pkg = {
    format: AGENT_PACKAGE_FORMAT,
    version: AGENT_PACKAGE_VERSION,
    package: {
      key, version: toSemver(manifest.version ?? '1.0.0'), name: title,
      ...(description ? { description } : {}),
      ...(manifest.author ? { author: typeof manifest.author === 'string' ? { name: manifest.author } : { name: manifest.author.name, url: manifest.author.url } } : {}),
      source: { kind: parts.kind, path: posix(relative(root, parts.base)) || '.', ...(manifest.repository ? { repo: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url } : {}) },
    },
    ...(subagents.length ? { team: { name: title, lead: lead.key, members: agents.map((a) => a.key) } } : {}),
    agents,
    ...(skills.length ? { skills } : {}),
    ...(servers.length ? { mcp_servers: servers } : {}),
    ...(notTranslated.length ? { not_translated: notTranslated } : {}),
    ...(scripts.size ? { scripts: [...scripts.values()] } : {}),
    ...(files.size ? { files: [...files.values()] } : {}),
    ...(requirements && (scripts.size || files.size) ? { requirements } : {}),
    ...(secretByName.size ? { secrets_needed: [...secretByName.values()] } : {}),
    evals: [{ task: 'TODO: a small real run of the whole package', must_include: [] }],
  };
  return {
    pkg,
    report: {
      kind: parts.kind, key, agents: agents.map((a) => a.key), team: !!pkg.team, skills: skills.map((s) => s.key),
      mcp_servers: servers.map((s) => `${s.key} (${s.transport})`), scripts: scripts.size, files: files.size,
      secrets_needed: [...secretByName.keys()], not_translated: notTranslated, warnings,
      ok: !warnings.some((w) => /takes at most|only exist on this machine|not valid JSON/.test(w)),
    },
  };
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const target = args.find((a, i) => !a.startsWith('--') && !['--root', '--package', '--key'].includes(args[i - 1]));
  if (!target) {
    console.error('Usage: node scan-plugin.mjs <plugin folder | project folder | SKILL.md> [--root <project>] [--package <out.json>] [--key <key>]');
    process.exit(2);
  }
  const parts = findParts(target);
  const { pkg, report } = buildPackage(parts, { root: flag('--root'), key: flag('--key') });
  const out = flag('--package');
  if (out) { writeFileSync(out, JSON.stringify(pkg, null, 2)); report.package_written = out; }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv);

