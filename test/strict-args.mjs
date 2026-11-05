// Selftest for the strict input schemas on the two tools where a stripped key
// changes the ANSWER rather than the wording.
//
// Background: `server.tool(name, desc, rawShape, ...)` wraps the shape in
// `z.object(shape)`, whose default is STRIP — an unknown key is deleted and
// nothing is said. But the schema the SDK publishes at `tools/list` carries
// `additionalProperties: false`, so the package promised rejection and shipped
// deletion. Measured on the published 1.2.12 tarball:
//
//   list_services {"query":"mime","limit":3}
//     -> isError:false, the first three catalog entries (x402-gas,
//        x402-captcha-solve, ...) — i.e. an UNFILTERED listing the caller
//        cannot distinguish from a filtered one.
//
//   register {"name":"x","adress":"0x..."}   (misspelled `wallet`)
//     -> `wallet` arrives undefined, so the tool generates a FRESH wallet and
//        answers `status:"registered"` with a key the caller never asked for.
//
// The controls below pin `.strict()` on both, and pin that `.strict()` did not
// break the declared shape.
//
// Usage: node test/strict-args.mjs [path-to-dist/index.js]
// Exit 0 = every control behaved; 1 = at least one did not.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = process.argv[2] || path.join(here, "..", "dist", "index.js");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const child = spawn(process.execPath, [distPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
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
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
child.stderr.on("data", () => {});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

const textOf = (r) => (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "strict-args-selftest", version: "1" },
});
notify("notifications/initialized");

// 1. The published schema still makes the strictness promise.
const tl = await rpc("tools/list", {});
const names = (tl.result?.tools ?? []).map((t) => t.name);
check("tools/list still advertises all six tools", names.length === 6, names.join(","));
const ls = tl.result?.tools?.find((t) => t.name === "minia2a_list_services");
check(
  "list_services schema still says additionalProperties:false",
  ls?.inputSchema?.additionalProperties === false,
  JSON.stringify(ls?.inputSchema?.additionalProperties)
);

// 2. Unknown key on the discovery tool is named, not dropped.
const q = await rpc("tools/call", {
  name: "minia2a_list_services",
  arguments: { query: "mime", limit: 3 },
});
const qt = textOf(q);
check("list_services rejects an unknown key", q.result?.isError === true, qt.slice(0, 160));
check(
  "the error names the offending key",
  /Unrecognized key/.test(qt) && /query/.test(qt),
  qt.slice(0, 160)
);
check(
  "no catalog rows are returned alongside the error",
  !/"id":/.test(qt),
  qt.slice(0, 160)
);

// 3. The declared shape is not rejected — .strict() must not have broken the tool.
const good = await rpc("tools/call", {
  name: "minia2a_list_services",
  arguments: { search: "mime", limit: 3 },
});
const gt = textOf(good);
check(
  "a declared argument set is not a validation error",
  !/Input validation error/.test(gt),
  gt.slice(0, 160)
);

// 4. Unknown key on the wallet tool is named before any wallet is generated.
const reg = await rpc("tools/call", {
  name: "minia2a_register",
  arguments: { name: "strict-args-selftest", adress: "0x0000000000000000000000000000000000000001" },
});
const rt = textOf(reg);
check("register rejects a misspelled wallet key", reg.result?.isError === true, rt.slice(0, 160));
check(
  "register emits no private key on that path",
  !/privateKey/.test(rt),
  rt.slice(0, 160)
);

// 5. A tool left on the old registration path is untouched.
const stats = await rpc("tools/call", { name: "minia2a_get_stats", arguments: {} });
check(
  "get_stats still answers without a validation error",
  !/Input validation error/.test(textOf(stats)),
  textOf(stats).slice(0, 160)
);

child.kill();
console.log(failures === 0 ? "\nSELFTEST: PASS" : `\nSELFTEST: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
