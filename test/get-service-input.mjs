// Selftest for `minia2a_get_service` telling the truth about its input contract.
//
// The tool description promised an "input schema" and the answer never carried
// one: `/api/services` has no such field, so the published 1.2.12 returned
// id/name/description/endpoint/price and stopped. The next step an agent takes
// is `call_service`, which needs the parameter names.
//
// 1.2.15 reads them off the service's own unpaid 402
// (`extensions.bazaar.info.input`) — a challenge, so nothing is charged and no
// trial is spent — and says so when the endpoint does not carry the block.
//
// The controls pin both halves, because "absent stays absent" is the failure
// mode this family keeps producing: an `input: {}` would read as "takes no
// parameters", which is a confident wrong answer.
//
// Needs network (minia2a.uk). Usage: node test/get-service-input.mjs [dist]

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = process.argv[2] || path.join(here, "..", "dist", "index.js");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const child = spawn(process.execPath, [distPath], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 0;
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
  setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
});
const textOf = (r) => (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "get-service-input-selftest", version: "1" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const r = await rpc("tools/call", {
  name: "minia2a_get_service",
  arguments: { serviceId: "x402-mime-type" },
});
const txt = textOf(r);
let doc = null;
try { doc = JSON.parse(txt); } catch { /* asserted below */ }

check("get_service answers JSON", doc !== null, txt.slice(0, 160));
check(
  "the answer carries exactly one of input / inputNote",
  (!!doc?.input) !== (!!doc?.inputNote),
  JSON.stringify(Object.keys(doc ?? {}))
);
if (doc?.input) {
  check(
    "the input hint names its source",
    typeof doc.input.from === "string" && doc.input.from.length > 0,
    JSON.stringify(doc.input)
  );
  const params =
    Object.keys(doc.input.queryParams ?? {}).length +
    (doc.input.body && typeof doc.input.body === "object" ? Object.keys(doc.input.body).length : 0);
  check(
    "the input hint names at least one parameter",
    params > 0,
    JSON.stringify(doc.input)
  );
} else {
  check(
    "the note explains the absence instead of leaving it empty",
    /documentation URL/.test(doc.inputNote ?? ""),
    String(doc.inputNote)
  );
}

// A service that does not exist must still say so, not fall through to a hint.
const miss = await rpc("tools/call", {
  name: "minia2a_get_service",
  arguments: { serviceId: "x402-no-such-service-selftest" },
});
check(
  "an unknown id reports not-found",
  /not found/i.test(textOf(miss)),
  textOf(miss).slice(0, 160)
);

child.kill();
console.log(failures === 0 ? "\nSELFTEST: PASS" : `\nSELFTEST: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
