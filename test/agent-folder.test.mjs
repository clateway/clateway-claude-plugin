import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { META_FILE, encode, readFolder, safeRelative, setBase, taken, writeFolder } from "../clateway/scripts/agent-folder.mjs";

const pullAnswer = {
  agent: { id: "a1", name: "Ledger Clerk" },
  files: [
    { path: "agent.yaml", text: "role_title: Clerk\n" },
    { path: "instructions.md", text: "Read the ledger." },
    { path: "evals.yaml", text: "[]\n" },
    { path: "files/logo.png", base64: Buffer.from([0x89, 0x50, 0x00, 0x01]).toString("base64") },
    { path: META_FILE, text: JSON.stringify({ agent_id: "a1", base_revision_id: "r1", base_revision_number: 1 }) },
  ],
};

test("pull writes every file; read gives the push arguments back", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  const out = writeFolder(pullAnswer, dir);
  assert.equal(out.files.length, 5);
  assert.deepEqual([...readFileSync(join(dir, "files/logo.png"))], [0x89, 0x50, 0x00, 0x01]);
  writeFileSync(join(dir, "instructions.md"), "Read the ledger twice.");
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  writeFileSync(join(dir, "node_modules/x/index.js"), "x");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  const push = readFolder(dir);
  assert.equal(push.agent, "a1");
  assert.equal(push.base_revision_id, "r1");
  assert.deepEqual(push.files.map((f) => f.path), ["agent.yaml", "evals.yaml", "files/logo.png", "instructions.md"]);
  assert.equal(push.files.find((f) => f.path === "instructions.md").text, "Read the ledger twice.");
  assert.ok(push.files.find((f) => f.path === "files/logo.png").base64);
});

test("refuses a folder that is not empty and paths that leave it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  writeFileSync(join(dir, "keep.txt"), "x");
  assert.throws(() => writeFolder(pullAnswer, dir), /not empty/);
  assert.equal(safeRelative("../etc/passwd"), null);
  assert.equal(safeRelative("/abs"), null);
  assert.equal(safeRelative("scripts/run.py"), "scripts/run.py");
  assert.throws(() => writeFolder({ files: [{ path: "../x", text: "" }] }, mkdtempSync(join(tmpdir(), "agent-"))), /Refusing/);
});

test("set-base records the draft after a push", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  writeFolder(pullAnswer, dir);
  const meta = setBase(dir, "d7", "3");
  assert.equal(meta.base_revision_id, "d7");
  assert.equal(meta.base_revision_number, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, META_FILE), "utf8")).base_status, "draft");
});

test("what read takes", () => {
  assert.equal(taken("scripts/run.py"), true);
  assert.equal(taken(".gitignore"), true);
  assert.equal(taken(".vscode/settings.json"), false);
  assert.equal(taken("inputs/data.csv"), false);
  assert.equal(taken("keys/server.pem"), false);
  assert.equal(taken(META_FILE), false);
  assert.deepEqual(encode(Buffer.from("héllo")), { text: "héllo" });
  assert.ok(encode(Buffer.from([0, 1, 2])).base64);
});
