// Selftest for minia2a_check_endpoint.
//
// Runs the real server over stdio against local fixtures, so it exercises the
// same path an agent does. Three fixtures, each on its own origin, and the
// reason each exists:
//
//   canonical — 402 with the real PAYMENT-REQUIRED header shape the platform
//               serves, and an /api/agent-ready answering the flat shape.
//               MUST score AUTO-MODE READY. This is the regression test for the
//               2026-09-18 bug: the shipped 1.1.32 build scores this fixture
//               11/100, because it only looked for x-402-* headers.
//   legacy    — 402 with the older x-402-amount/chain/recipient headers plus a
//               _trial block. MUST also reach READY, or the fix would have
//               traded one blind spot for another.
//   broken    — 200 with an empty JSON body, no challenge, no trial, no
//               registration, and an /api/agent-ready that answers 404.
//               MUST stay below 50. Without this the score could be a
//               predicate that says yes to everything.
//
// Usage: node test/check-endpoint.mjs [path-to-dist/index.js]
// Exit 0 = every control behaved; 1 = at least one did not.

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = process.argv[2] || path.join(here, "..", "dist", "index.js");

const challenge = {
  x402Version: 2,
  error: "Payment required",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "500000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xAb62452b4b019bC4402BFfCca6C706d16d72A7Bf",
      maxTimeoutSeconds: 120,
    },
  ],
  trialExhausted: true,
  message: "Free trial calls are wallet-based.",
  nextSteps: [
    "Trial: add ?wallet=0xYOUR_WALLET plus X-Wallet-Signature and X-Trial-Timestamp — 5 free calls per wallet, no registration",
  ],
};

const agentReadyFlat = {
  ok: true,
  server: "minia2a",
  status: "ready",
  services: 1698,
  paymentRoutes: 2,
  facilitator: true,
  onchain: true,
};

// The canonical fixture deliberately imitates the platform's probe handling:
// a `probe=1` QUERY PARAM gets the reduced body (message/nextSteps/
// trialExhausted dropped), while the plain path -- or any request that carries
// the X-x402-Probe HEADER instead -- gets the full one. Verified against the
// live origin: `?probe=1` strips, `?probe=0`, `?foo=1` and the header do not.
//
// Without this the fixture answered every request identically, so it could not
// have caught the second half of the 2026-09-18 bug: the checker asked for the
// reduced body and then graded it for the guidance fields the platform had
// (correctly, on request) withheld.
const seen = {};

const FIXTURES = {
  canonical: {
    origin: "http://127.0.0.1:8731",
    agentReady: 200,
    respond(req, res) {
      const url = new URL(req.url, "http://127.0.0.1:8731");
      seen.canonical = {
        query: url.search,
        probeHeader: req.headers["x-x402-probe"] || null,
      };
      // The reduced body keeps accepts[] but drops the guidance fields.
      const reduced = /(^|&)probe=1(&|$)/.test(url.search) && !req.headers["x-x402-probe"];
      const payload = reduced
        ? { x402Version: challenge.x402Version, error: challenge.error, accepts: challenge.accepts }
        : challenge;
      const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
      res.writeHead(402, {
        "content-type": "application/json; charset=utf-8",
        "payment-required": b64,
      });
      res.end(JSON.stringify(payload));
    },
  },
  legacy: {
    origin: "http://127.0.0.1:8732",
    agentReady: 200,
    respond(req, res) {
      res.writeHead(402, {
        "content-type": "application/json",
        "x-402-amount": "500000",
        "x-402-chain": "base",
        "x-402-recipient": "0xAb62452b4b019bC4402BFfCca6C706d16d72A7Bf",
        "x-402-register": "https://example.test/register",
      });
      res.end(JSON.stringify({ x402Version: 1, _trial: { remaining: 5, limit: 5 } }));
    },
  },
  broken: {
    origin: "http://127.0.0.1:8733",
    agentReady: 404, // readiness must not be borrowable from a shared origin
    respond(req, res) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  },
};

/** Start one fixture origin. */
function startFixture(spec) {
  const port = Number(new URL(spec.origin).port);
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, spec.origin);
    if (url.pathname === "/api/agent-ready") {
      if (spec.agentReady !== 200) {
        res.writeHead(spec.agentReady, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(agentReadyFlat));
    }
    spec.respond(req, res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

/** Drive the built server over stdio and return the parsed tool output. */
function drive(endpointUrl) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [distPath], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`${endpointUrl}: timed out`));
    }, 30000);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        clearTimeout(timer);
        p.kill();
        const txt = (msg.result?.content || []).map((c) => c.text).join("");
        try {
          resolve(JSON.parse(txt));
        } catch {
          reject(new Error(`${endpointUrl}: unparseable tool output: ${txt.slice(0, 200)}`));
        }
      }
    });
    p.on("error", reject);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "selftest", version: "1" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "minia2a_check_endpoint", arguments: { endpointUrl } },
    });
  });
}

const servers = await Promise.all(Object.values(FIXTURES).map(startFixture));
const results = {};
for (const [name, spec] of Object.entries(FIXTURES)) {
  results[name] = await drive(`${spec.origin}/${name}`);
}
servers.forEach((s) => s.close());

const cases = [];
const check = (name, cond, detail) => cases.push({ name, ok: !!cond, detail });
const sig = (r, signal) => r.checks.find((c) => c.signal === signal);

const { canonical, legacy, broken } = results;

// Stimulus control. Before blaming the endpoint for missing trial/registration
// guidance, check what was asked for: `?probe=1` makes the platform withhold
// exactly those fields. The checker must self-identify by header instead.
check(
  "checker did not ask for the reduced probe body",
  seen.canonical && !/(^|&)probe=1(&|$)/.test(seen.canonical.query || ""),
  `query=${JSON.stringify(seen.canonical?.query)}`
);
check(
  "checker still self-identified as a probe (via header)",
  seen.canonical?.probeHeader === "1",
  `X-x402-Probe=${JSON.stringify(seen.canonical?.probeHeader)}`
);

// Positive control: the canonical shape the platform actually serves must pass.
check("canonical is AUTO-MODE READY", canonical.score >= 80, `score=${canonical.score} ${canonical.rating}`);
check(
  "canonical read the PAYMENT-REQUIRED header",
  sig(canonical, "Payment challenge")?.result === "PASS" && /PAYMENT-REQUIRED/.test(sig(canonical, "Payment challenge")?.detail || ""),
  sig(canonical, "Payment challenge")?.detail
);
check("canonical got the amount", sig(canonical, "Payment amount")?.result === "PASS", sig(canonical, "Payment amount")?.detail);
check(
  "canonical got the network",
  sig(canonical, "Payment network")?.result === "PASS" && /eip155:8453/.test(sig(canonical, "Payment network")?.detail || ""),
  sig(canonical, "Payment network")?.detail
);
check("canonical got the payTo", sig(canonical, "Payment recipient")?.result === "PASS", sig(canonical, "Payment recipient")?.detail);
check("canonical got trial info", sig(canonical, "Trial info")?.result === "PASS", sig(canonical, "Trial info")?.detail);
check("canonical got a registration path", sig(canonical, "Registration path")?.result === "PASS", sig(canonical, "Registration path")?.detail);

// Backward compatibility: the older vocabulary must not have been sacrificed.
check("legacy x-402-* is AUTO-MODE READY", legacy.score >= 80, `score=${legacy.score} ${legacy.rating}`);
check("legacy got the amount", sig(legacy, "Payment amount")?.result === "PASS", sig(legacy, "Payment amount")?.detail);
check("legacy got the network", sig(legacy, "Payment network")?.result === "PASS", sig(legacy, "Payment network")?.detail);

// Negative control: none of the signals are present.
check("broken stays below 50", broken.score < 50, `score=${broken.score} ${broken.rating}`);
check("broken fails the payment challenge", sig(broken, "Payment challenge")?.result === "FAIL", sig(broken, "Payment challenge")?.detail);
check("broken fails the agent-ready signal", sig(broken, "Agent-Ready endpoint")?.result === "FAIL", sig(broken, "Agent-Ready endpoint")?.detail);
check("broken fails registration", sig(broken, "Registration path")?.result === "FAIL", sig(broken, "Registration path")?.detail);

// The reported score must be reproducible from the checks it printed. This is
// asserted with `credited`, not with `result`: a 402 endpoint prints PASS for
// reachability at weight 15 while earning 7.5, so reconstructing the score from
// PASS/FAIL alone gives a different number than the one reported.
for (const [name, r] of Object.entries(results)) {
  const weightSum = r.checks.reduce((s, c) => s + c.weight, 0);
  const credited = r.checks.reduce((s, c) => s + (c.credited ?? 0), 0);
  check(
    `${name}: score reproducible from its own printed checks`,
    r.score === Math.round((credited / weightSum) * 100),
    `credited ${credited}/${weightSum} -> score ${r.score}`
  );
}

// No output may assert a deadline date (the old build hardcoded one).
const blob = JSON.stringify(results);
check("no hardcoded auto-mode deadline", !/autoModeDeadline|Aug 14/.test(blob), "checked all fixtures");

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
}
console.log(`\n${cases.length - bad}/${cases.length} passed  (dist: ${distPath})`);
process.exit(bad ? 1 : 0);
