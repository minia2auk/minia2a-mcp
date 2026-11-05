// Rewrite the `tools` array inside server.json from the server's own
// `tools/list`, so the official-registry record cannot describe a tool shape
// the package does not have.
//
// Why (2026-11-05): the record shipped by hand had drifted from the code in
// four places. `minia2a_check_endpoint` was documented as taking `url` while
// the tool takes `endpointUrl`; `list_services` was missing `limit`;
// `call_service` was missing `privateKey` and `autoPay`. An agent that reads
// the registry — the discovery surface with the widest reach — learns the
// wrong argument name. The tool then rejects it (a required field is missing),
// so the cost is a failed first call, which is exactly the call that decides
// whether the agent tries again.
//
// This is generated, not hand-maintained: run it before every publish, and
// `npm test` compares the result to the file (see test/registry-tools.mjs).
//
// Usage: node scripts/sync-registry-tools.mjs [--check]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const distPath = path.join(root, "dist", "index.js");
const serverJsonPath = path.join(root, "server.json");
const checkOnly = process.argv.includes("--check");

const child = spawn(process.execPath, [distPath], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 0;
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
child.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
});

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "sync-registry-tools", version: "1" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = await rpc("tools/list", {});
child.kill();

const tools = (listed.result?.tools ?? []).map((t) => {
  const schema = JSON.parse(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }));
  delete schema.$schema;
  delete schema.title;
  const out = { name: t.name, description: t.description ?? "", inputSchema: schema };
  return out;
});

if (tools.length === 0) {
  console.error("ABORT: tools/list returned nothing; refusing to write an empty record");
  process.exit(2);
}

const record = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
const meta = record._meta?.["io.modelcontextprotocol.registry/publisher-provided"];
if (!meta) {
  console.error("ABORT: server.json has no publisher-provided _meta block");
  process.exit(2);
}

const before = JSON.stringify(meta.tools ?? null);
const after = JSON.stringify(tools);
if (checkOnly) {
  if (before === after) {
    console.log(`ok    server.json tools match tools/list (${tools.length} tool(s))`);
    process.exit(0);
  }
  console.error("FAIL  server.json tools differ from tools/list — run: node scripts/sync-registry-tools.mjs");
  const oldNames = (JSON.parse(before) ?? []).map((t) => t.name).join(",");
  console.error(`      file: ${oldNames}`);
  console.error(`      live: ${tools.map((t) => t.name).join(",")}`);
  process.exit(1);
}

meta.tools = tools;
fs.writeFileSync(serverJsonPath, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${tools.length} tool(s) into server.json: ${tools.map((t) => t.name).join(", ")}`);
