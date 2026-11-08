#!/usr/bin/env node
/**
 * An agent's folder on this computer, for /clateway-agent (Clateway Tenant MCP tools agents_workspace_*).
 *
 *   node agent-folder.mjs write <pull-answer.json> [folder] [--force]   write what agents_workspace_pull answered
 *   node agent-folder.mjs read [folder] [--out push.json]                the arguments for agents_workspace_push
 *   node agent-folder.mjs set-base <folder> <revision id> [number]       after a push: the new base revision
 *
 * The folder holds agent.yaml, instructions.md, evals.yaml, scripts/…, files/… and .clateway-agent.json.
 * `read` leaves out what Clateway never takes from a folder (the same rules as its VS Code read-back):
 * node_modules, caches, inputs/, hidden folders, .env and key files.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const META_FILE = ".clateway-agent.json";
export const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", ".venv", "dist", "build", "inputs"]);
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx))$/i;
export const MAX_DEPTH = 6;

/** A path from the pull answer that stays inside the folder. */
export function safeRelative(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/** Whether `read` takes this relative path from the folder. */
export function taken(path) {
  const parts = path.split("/");
  if (parts.length > MAX_DEPTH) return false;
  if (parts.slice(0, -1).some((d) => d.startsWith(".") || SKIP_DIRS.has(d))) return false;
  const name = parts.at(-1);
  if (name === META_FILE || name === ".DS_Store" || SECRET_FILE.test(path)) return false;
  return true;
}

/** Text when it is valid UTF-8 without NUL bytes, else base64. */
export function encode(bytes) {
  if (!bytes.includes(0)) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch { /* binary */ }
  }
  return { base64: Buffer.from(bytes).toString("base64") };
}

const slug = (name) => String(name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

export function writeFolder(answer, folder, { force = false } = {}) {
  const data = answer?.data ?? answer;
  const files = Array.isArray(data?.files) ? data.files : null;
  if (!files) throw new Error("This is not an agents_workspace_pull answer (no files).");
  const dir = resolve(folder || slug(data.agent?.name));
  if (existsSync(dir) && readdirSync(dir).length && !force) throw new Error(`${dir} is not empty (use --force to write over it).`);
  const written = [];
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (!rel) throw new Error(`Refusing the path ${JSON.stringify(f.path)}.`);
    const target = join(dir, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof f.text === "string" ? f.text : Buffer.from(String(f.base64 ?? ""), "base64"));
    written.push(rel);
  }
  return { folder: dir, files: written };
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join("/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name) || rel.split("/").length >= MAX_DEPTH) continue;
      walk(full, root, out);
    } else if (st.isFile() && taken(rel)) {
      out.push(rel);
    }
  }
}

export function readFolder(folder = ".") {
  const dir = resolve(folder);
  const metaPath = join(dir, META_FILE);
  if (!existsSync(metaPath)) throw new Error(`${META_FILE} is missing: pull the agent into this folder first.`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const paths = [];
  walk(dir, dir, paths);
  paths.sort();
  return {
    agent: meta.agent_id,
    base_revision_id: meta.base_revision_id,
    files: paths.map((p) => ({ path: p, ...encode(readFileSync(join(dir, ...p.split("/")))) })),
  };
}

export function setBase(folder, revisionId, number) {
  const metaPath = join(resolve(folder || "."), META_FILE);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.base_revision_id = revisionId;
  if (number !== undefined && number !== "") meta.base_revision_number = Number(number);
  meta.base_status = "draft";
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--out");
  try {
    if (cmd === "write") {
      const answer = JSON.parse(readFileSync(args[0], "utf8"));
      console.log(JSON.stringify(writeFolder(answer, args[1], { force: flags.has("--force") }), null, 2));
    } else if (cmd === "read") {
      const payload = JSON.stringify(readFolder(args[0]));
      const out = rest[rest.indexOf("--out") + 1];
      if (flags.has("--out") && out) {
        writeFileSync(out, payload);
        const n = JSON.parse(payload).files.length;
        console.log(`Wrote ${out} (${n} files).`);
      } else {
        console.log(payload);
      }
    } else if (cmd === "set-base") {
      const [folder, id, number] = args;
      if (!folder || !id) throw new Error("Usage: set-base <folder> <revision id> [number]");
      console.log(JSON.stringify(setBase(folder, id, number), null, 2));
    } else {
      console.error("Usage: agent-folder.mjs write <answer.json> [folder] [--force] | read [folder] [--out file] | set-base <folder> <revision id> [number]");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
