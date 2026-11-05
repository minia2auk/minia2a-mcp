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

// The registry caps its `publisher-provided` extension at 4 KB, which the full
// tools/list schemas blow through (5,854 B on 2026-11-05 — `publish` answered
// HTTP 400 and named the limit). So the record carries NAME + the tool's own
// first sentence and deliberately NO inputSchema: a field-level schema is the
// part that can be wrong at the argument name (the `url` vs `endpointUrl`
// drift), and a partial description cannot contradict the tool the way a
// wrong schema can. Full shapes stay on the package, which is what the record
// points at.
const firstSentence = (s, max = 110) => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.!?](\s|$)/);
  const s1 = cut > 0 ? flat.slice(0, cut + 1) : flat;
  return s1.length <= max ? s1 : s1.slice(0, max - 1).trimEnd() + "…";
};

const tools = (listed.result?.tools ?? []).map((t) => ({
  name: t.name,
  description: firstSentence(t.description),
}));

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

// The registry caps the publisher-provided extension at 4 KB and answers only
// "HTTP 400 Failed to publish server" when it is over. Measure it here, where
// the message can say by how much. Compact JSON is what the registry counts.
const META_LIMIT = 4096;
const metaBytes = Buffer.byteLength(JSON.stringify({ ...meta, tools }), "utf8");
if (metaBytes > META_LIMIT) {
  console.error(
    `ABORT: _meta would be ${metaBytes} B, over the registry's ${META_LIMIT} B limit by ${metaBytes - META_LIMIT}`
  );
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
