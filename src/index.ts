#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Wallet } from "ethers";
import { createRequire } from "node:module";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read version from package.json at runtime so the banner + handshake never drift
// from the published version (this has gone stale three times before).
const VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const MINIA2A_API = "https://minia2a.uk/api";

// ── Types ────────────────────────────────────────────────────────────

interface Service {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  price?: number;
  priceCents?: number;
  category?: string;
  tags?: string[];
  owner?: string;
}

interface StatsResponse {
  services: number;
  registeredAgents: number;
  totalCalls: number;
  totalVolumeCents: number;
  realOnChain: { count: number; usdc: number };
  realTopUps: { count: number; usdc: number };
  totalTransactions: number;
  uptime: number;
  totalRequests: number;
  fee: string;
  platformWallet: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

// Requests to minia2a's own endpoints carry X-Agent-ID so the gateway can count
// real adopting agents. Not sent on the x402-validate probes, which hit
// caller-supplied URLs — our identity has no business going to third parties.
// The server stores only HMAC-SHA256(secret, id) — the raw id never lands in the DB.
// Identity is per-machine (env → id file → generated once), not per-process:
// a per-process id would count every restart as a brand-new agent and inflate the metric.
//
// Two id locations exist across our published clients: this one, `minia2a-client`
// and `@minia2a/sdk` read ~/.minia2a-agent-id (the path adoption.go names), while
// `minia2a-cli` historically wrote ~/.minia2a/agent-id. Reading only one mints a
// second id on a machine that already has one, and that machine is counted as
// two agents. Read both, in that order.
let _agentId: string | undefined;
function agentId(): string {
  if (_agentId) return _agentId;
  if (process.env.MINIA2A_AGENT_ID) return (_agentId = process.env.MINIA2A_AGENT_ID);
  const candidates = [
    join(homedir(), ".minia2a-agent-id"),
    join(homedir(), ".minia2a", "agent-id"),
  ];
  for (const file of candidates) {
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return (_agentId = existing);
    } catch {
      // not created yet — fall through to the next candidate
    }
  }
  const file = candidates[0];
  _agentId = "agent:" + randomUUID();
  try {
    writeFileSync(file, _agentId);
  } catch {
    // read-only home: keep the in-memory id, just don't persist it
  }
  return _agentId;
}

let servicesCache: { data: Service[]; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 minutes

async function fetchServices(): Promise<Service[]> {
  if (servicesCache && Date.now() - servicesCache.ts < CACHE_TTL) {
    return servicesCache.data;
  }
  const res = await fetch(`${MINIA2A_API}/services`, {
    headers: { "X-Agent-ID": agentId() },
  });
  if (!res.ok) throw new Error(`minia2a API returned ${res.status}`);
  const json = await res.json();
  const data = (json.services || json) as Service[];
  servicesCache = { data, ts: Date.now() };
  return data;
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${MINIA2A_API}/stats`, {
    headers: { "X-Agent-ID": agentId() },
  });
  if (!res.ok) throw new Error(`minia2a API returned ${res.status}`);
  const json = await res.json();
  return {
    services: json.services,
    registeredAgents: json.registration?.totalUsers || 0,
    totalCalls: json.totalCalls,
    totalVolumeCents: json.totalVolumeCents,
    realOnChain: json.realOnChain || { count: 0, usdc: 0 },
    realTopUps: json.realTopUps || { count: 0, usdc: 0 },
    totalTransactions: json.totalTransactions,
    uptime: json.uptime,
    totalRequests: json.totalRequests,
    fee: json.fee,
    platformWallet: json.platformWallet,
  } as StatsResponse;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)} USDC`;
}

function formatUsdc(usdc: number): string {
  return `$${usdc.toFixed(2)} USDC`;
}

// ── V5 wallet auth ───────────────────────────────────────────────────

const REGISTER_MESSAGE_PREFIX = "minia2a register: ";

// Register an agent against V5's self-custody model. If the caller supplies a
// wallet + EIP-191 signature, use them verbatim (the caller holds the key). If
// not, generate a fresh wallet here, sign the fixed message, and hand the
// private key back to the caller — the platform never sees or stores it.
async function registerAgent(name: string, wallet?: string, signature?: string) {
  let address = wallet;
  let sig = signature;
  let generatedPrivateKey: string | undefined;

  if (!address || !sig) {
    const w = Wallet.createRandom();
    address = w.address;
    generatedPrivateKey = w.privateKey;
    sig = await w.signMessage(`${REGISTER_MESSAGE_PREFIX}${w.address}`);
  }

  const res = await fetch(`${MINIA2A_API}/v1/register-simple`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId() },
    body: JSON.stringify({ name, wallet: address, signature: sig }),
  });
  const data = await res.json();
  return {
    ok: res.ok,
    status: res.status,
    data,
    wallet: address,
    privateKey: generatedPrivateKey,
  };
}

// Lazily wrap fetch for auto-pay. The wrapped fetch completes the x402 payment
// (exact-permit2 USDC on Base) and retries when a service answers 402. Only built
// when the caller explicitly opts into autoPay with a usable key — never by default.
function makePayingFetch(privateKey: string) {
  const hex = (privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(hex);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    spendControls: false,
  });
}

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "minia2a",
  version: VERSION,
});

// ── Tool: list_services ──────────────────────────────────────────────

server.tool(
  "minia2a_list_services",
  "List available x402 services on minia2a.uk — the micropayment marketplace for AI agents. Returns service name, description, price, and endpoint for each service. Use this to discover what capabilities are available before calling them.",
  {
    category: z
      .string()
      .optional()
      .describe("Filter by category (e.g., 'crypto', 'utility', 'data', 'ai')"),
    search: z
      .string()
      .optional()
      .describe("Search term to filter services by name or description"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max number of results to return (default 20)"),
  },
  { readOnlyHint: true },
  async ({ category, search, limit }) => {
    let services = await fetchServices();

    if (category) {
      const cat = category.toLowerCase();
      services = services.filter(
        (s) =>
          s.category?.toLowerCase() === cat ||
          s.tags?.some((t) => t.toLowerCase() === cat)
      );
    }

    if (search) {
      const q = search.toLowerCase();
      services = services.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      );
    }

    // `total` must reflect the FULL matching count, not the sliced page —
    // reporting `result.length` here made the catalog look like it had only
    // `limit` services (e.g. "total: 20" for a 1,600+ service marketplace).
    const matched = services.length;
    const result = services.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: matched,
              returned: result.length,
              truncated: result.length < matched,
              platform: "minia2a.uk",
              payment: "x402 protocol — per-call USDC micropayments",
              services: result.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                endpoint: s.endpoint,
                price: s.priceCents != null ? formatCents(s.priceCents) : "varies",
                category: s.category || "uncategorized",
                tags: s.tags || [],
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: get_service ────────────────────────────────────────────────

server.tool(
  "minia2a_get_service",
  "Get detailed information about a specific x402 service on minia2a.uk, including its price, endpoint URL, input schema, and usage instructions. Use this before calling a service to understand what it needs.",
  {
    serviceId: z.string().describe("The service ID or name to get details for"),
  },
  { readOnlyHint: true },
  async ({ serviceId }) => {
    const services = await fetchServices();
    const service = services.find(
      (s) =>
        s.id === serviceId ||
        s.name.toLowerCase() === serviceId.toLowerCase() ||
        s.name.toLowerCase().includes(serviceId.toLowerCase())
    );

    if (!service) {
      return {
        content: [
          {
            type: "text",
            text: `Service "${serviceId}" not found on minia2a.uk. Use minia2a_list_services to browse available services.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: service.id,
              name: service.name,
              description: service.description,
              endpoint: service.endpoint,
              price: service.priceCents != null
                ? formatCents(service.priceCents)
                : "varies by service",
              category: service.category || "uncategorized",
              tags: service.tags || [],
              how_to_call: `Call ${service.endpoint} with a signed wallet (privateKey) to use its 5 free trial calls — no registration needed. Or call anonymously to hit the paid 402 path. When trials run out you get HTTP 402 with an accepts[] payment array — pay in USDC and retry with a PAYMENT-SIGNATURE header (x402 V2).`,
              documentation: `https://minia2a.uk/service/${service.id}`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: get_stats ──────────────────────────────────────────────────

server.tool(
  "minia2a_get_stats",
  "Get current platform statistics for minia2a.uk — total services, registered agents, transaction volume, uptime, and more. Useful for understanding the marketplace's scale and health.",
  {},
  { readOnlyHint: true },
  async () => {
    const stats = await fetchStats();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              platform: "minia2a.uk",
              description: "x402 micropayment marketplace for AI agents",
              stats: {
                services: `${stats.services} x402 services available`,
                agents: `${stats.registeredAgents} registered agents`,
                totalCalls: stats.totalCalls.toLocaleString(),
                totalVolume: formatUsdc(stats.realOnChain.usdc),
                realTransactions: stats.realOnChain.count,
                topUps: formatUsdc(stats.realTopUps.usdc),
                totalTransactions: stats.totalTransactions,
                totalRequests: stats.totalRequests.toLocaleString(),
                platformFee: stats.fee,
                // /api/stats reports uptime in seconds — label it honestly,
                // not as "hours" (a 12-minute uptime read as "728 hours").
                uptimeSeconds: stats.uptime,
              },
              payment: {
                protocol: "x402 (HTTP 402 Payment Required)",
                currency: "USDC on Base",
                wallet: stats.platformWallet,
              },
              links: {
                home: "https://minia2a.uk",
                docs: "https://minia2a.uk/docs",
                npm: "https://www.npmjs.com/package/minia2a-mcp",
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: register ───────────────────────────────────────────────────

server.tool(
  "minia2a_register",
  "Register a self-custody wallet on minia2a.uk to publish your own services (EIP-191 signature). Registration is for publishing — it is NOT required for trials: any wallet signed in minia2a_call_service already gets 5 free trial calls. If you don't provide a wallet+signature, this tool generates a fresh wallet, signs 'minia2a register: <your-wallet>' with EIP-191, registers it, and returns the private key — store it, the platform never holds it.",
  {
    name: z
      .string()
      .describe("A name for your agent (e.g., 'my-trading-bot')"),
    wallet: z
      .string()
      .optional()
      .describe("Your existing self-custody wallet address (0x...). Omit to have a fresh wallet generated for you."),
    signature: z
      .string()
      .optional()
      .describe("EIP-191 signature of 'minia2a register: <wallet>'. Required if you supply a wallet."),
  },
  { destructiveHint: true },
  async ({ name, wallet, signature }) => {
    try {
      const { ok, data, wallet: address, privateKey } = await registerAgent(
        name,
        wallet,
        signature
      );
      if (ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "registered",
                  wallet: data.wallet || address,
                  freeTrialCalls: 5,
                  ...(privateKey
                    ? {
                        privateKey,
                        store_this:
                          "Store this private key securely — minia2a never holds it. It signs your future calls.",
                      }
                    : {}),
                  freeTrial:
                    "5 free trial calls per signed wallet across all services (no registration needed).",
                  next: "Use minia2a_call_service with privateKey=<your-key> to call services with your wallet's 5 free trial calls, then pay per call in USDC when they run out.",
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
                  error: data.error || "Registration failed",
                  hint:
                    data.hint ||
                    data.curl ||
                    "Supply name + wallet + signature (EIP-191 of 'minia2a register: <wallet>').",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "error",
                error: err instanceof Error ? err.message : "Unknown error",
                suggestion: "Check that minia2a.uk is reachable and try again.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// ── Tool: call_service ───────────────────────────────────────────────

server.tool(
  "minia2a_call_service",
  "Call an x402 service on minia2a.uk. Three access paths: (1) omit everything for the paid 402 path (sign a wallet for 5 free trial calls — no registration); (2) pass privateKey (or set MINIA2A_PRIVATE_KEY) for your wallet's own 5 trials — the key never leaves this process, it only signs the per-call trial message; (3) when both are exhausted the endpoint returns HTTP 402 with a machine-readable accepts[] array — pay in USDC and retry with a PAYMENT-SIGNATURE header (x402 V2). Set autoPay:true together with privateKey to have a 402 paid automatically in USDC on Base and the call retried — the wallet must hold USDC or the call still returns payment_required (never charges silently). Note that wallet= on its own does NOT reach the wallet bucket; the signature is what does.",
  {
    serviceId: z
      .string()
      .describe("The service ID (e.g., 'x402-gas') or full endpoint path"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe("JSON parameters to send to the service"),
    wallet: z
      .string()
      .optional()
      .describe("Your self-custody wallet address (0x...). Without privateKey this alone does not draw on the wallet's trial bucket."),
    privateKey: z
      .string()
      .optional()
      .describe("Private key of your wallet, used locally to sign the trial message (EIP-191). Never transmitted — only the resulting signature is sent. Falls back to the MINIA2A_PRIVATE_KEY env var."),
    autoPay: z
      .boolean()
      .optional()
      .default(false)
      .describe("When true and a privateKey is available, a 402 Payment Required response is paid automatically in USDC on Base via x402 and the call retried. Default false — you get a payment_required response instead of any automatic charge. Empty wallet (no USDC) still returns payment_required."),
  },
  { destructiveHint: true },
  async ({ serviceId, params, wallet, privateKey, autoPay }) => {
    const services = await fetchServices();
    const want = serviceId.toLowerCase();
    // Ordered narrowest-first. A previous version OR'd in `serviceId.startsWith("x402-")`,
    // which matched *every* service whenever the caller passed a canonical id — so asking
    // for x402-time called whatever sat first in the catalog. Exact id must win outright.
    const service =
      services.find((s) => s.id.toLowerCase() === want) ??
      services.find((s) => s.name.toLowerCase() === want) ??
      services.find((s) => s.name.toLowerCase().includes(want)) ??
      // Not in the catalog snapshot: an id-shaped argument is still callable by path,
      // which is what the old startsWith clause was reaching for.
      (/^[a-z0-9][a-z0-9-]*$/i.test(serviceId)
        ? {
            id: serviceId,
            name: serviceId,
            description: "",
            // The gateway routes /x402/<id> as well as /x402/<slug> (both return a 402
            // challenge; an unknown path 404s), so pass the id through unmodified.
            endpoint: `https://minia2a.uk/x402/${serviceId}`,
          }
        : undefined);

    if (!service) {
      return {
        content: [
          {
            type: "text",
            text: `Service "${serviceId}" not found. Use minia2a_list_services to browse.`,
          },
        ],
      };
    }

    const endpoint = service.endpoint.startsWith("http")
      ? service.endpoint
      : `https://minia2a.uk${service.endpoint}`;
    const url = new URL(endpoint);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `minia2a-mcp/${VERSION}`,
      "X-Agent-ID": agentId(),
    };

    // Wallet trials need a signature, not just the query param. The signed message is
    //   minia2a trial:<wallet>:<serviceId>:<unixSeconds>
    // where serviceId is the catalog id ("x402-time"), NOT the URL path segment ("time") —
    // signing the slug returns the same 402 a bad signature does, so we always use service.id.
    let trialSigner: string | null = null;
    const key = privateKey ?? process.env.MINIA2A_PRIVATE_KEY;
    if (key) {
      try {
        const signer = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
        // The gateway recovers the signer and compares it to ?wallet=, so both sides must be
        // the key's own address — a mismatched wallet argument cannot be signed for.
        trialSigner = signer.address;
        const ts = Math.floor(Date.now() / 1000).toString();
        headers["X-Wallet-Signature"] = await signer.signMessage(
          `minia2a trial:${trialSigner}:${service.id}:${ts}`
        );
        headers["X-Trial-Timestamp"] = ts;
      } catch {
        trialSigner = null; // unusable key — fall through to the unauthenticated 402 path
      }
    }

    const walletParam = trialSigner ?? wallet;
    if (walletParam) url.searchParams.set("wallet", walletParam);

    // autoPay: wrap fetch so a 402 is paid in USDC on Base and retried. Only when
    // the caller set autoPay:true AND supplied a usable key — otherwise the plain
    // fetch below returns payment_required unchanged (no silent charge).
    let payingFetch: typeof fetch | null = null;
    if (autoPay && key) {
      try {
        payingFetch = makePayingFetch(key);
      } catch {
        payingFetch = null; // unusable key → fall through to plain 402 path
      }
    }

    try {
      const res = await (payingFetch ?? fetch)(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });

      // x402: 402 means payment required (trials exhausted)
      if (res.status === 402) {
        let payment: any = {};
        try {
          payment = await res.json();
        } catch {
          payment = { raw: await res.text() };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "payment_required",
                  service: service.name,
                  x402Version: payment.x402Version ?? 2,
                  message: payment.message || payment.error || "Payment required.",
                  trialExhausted: payment.trialExhausted ?? false,
                  accepts: payment.accepts ?? [],
                  nextSteps: payment.nextSteps ?? [
                    "1. Get 5 free trial calls: call with privateKey to sign 'minia2a trial:<wallet>:<serviceId>:<ts>' (no registration).",
                    "2. Or pay per call: send USDC to the payTo address in accepts[0], then retry with a PAYMENT-SIGNATURE header (x402 V2).",
                  ],
                  howToProceed: trialSigner
                    ? `Signed as ${trialSigner}. A 402 here means this wallet's 5 trials are spent — pay via x402, or sign a fresh wallet (no registration needed) for 5 more trials.`
                    : wallet
                      ? "wallet= alone does not reach the wallet trial bucket. Pass privateKey (or set MINIA2A_PRIVATE_KEY) so the call can be signed, or pay per call."
                      : "No signed-wallet trials. Pass privateKey to sign this wallet for its 5 free trial calls (no registration), or pay per call.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!res.ok) {
        const errBody = await res.text();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
                  service: service.name,
                  httpStatus: res.status,
                  error: errBody,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = await res.json();
      const trialMode = res.headers.get("x-trial-mode");
      const trialRemaining = res.headers.get("x-trial-remaining");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                service: service.name,
                endpoint,
                result,
                // The gateway reports which bucket paid for the call; "wallet" means the
                // signature was accepted, "ip" means it silently used the anonymous bucket.
                trialMode: trialMode ?? "unreported",
                trialRemaining: trialRemaining ?? null,
                payment:
                  trialMode === "wallet"
                    ? `Wallet trial used for ${trialSigner}${trialRemaining ? ` — ${trialRemaining} left` : ""}`
                    : trialMode === "ip"
                      ? "Anonymous (IP-keyed) trial used."
                      : "Served without a reported trial bucket.",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "error",
                service: service.name,
                error: err instanceof Error ? err.message : "Unknown error",
                suggestion:
                  "Check that the service endpoint is reachable and try again.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// ── Tool: check_endpoint ──────────────────────────────────────────────
//
// 2026-09-18 — this checker used to ask only for the legacy
// `x-402-amount/chain/token/recipient` response headers. The platform moved to
// the canonical x402 v2 challenge: a `PAYMENT-REQUIRED` header carrying
// base64(JSON) whose `accepts[]` array holds amount/asset/network/payTo (the
// same JSON is the response body). So the scorer was reading a vocabulary the
// endpoints no longer speak, and every minia2a endpoint came back 11/100
// "NOT READY" against our own validator -- with the four payment signals
// alone worth 45 of 115, no endpoint could reach the 80 threshold no matter
// how correct it was.
//
// Both forms are now accepted, and each check's `detail` says WHICH form it
// found. That distinction is the point: "endpoint carries no payment info" and
// "endpoint speaks a form this tool did not recognise" are different findings
// with different fixes, and the old output could not tell them apart.

type X402Accept = {
  amount?: string;
  asset?: string;
  network?: string;
  payTo?: string;
  scheme?: string;
};

type X402Challenge = {
  accepts?: X402Accept[];
  trialExhausted?: boolean;
  nextSteps?: string[];
  message?: string;
};

/** Read the payment challenge from either the canonical header or the body. */
function readChallenge(
  resp: Response,
  body: any
): { from: string; challenge: X402Challenge | null } {
  const hdr = resp.headers.get("payment-required");
  if (hdr) {
    try {
      const decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
      if (decoded && Array.isArray(decoded.accepts)) {
        return { from: "PAYMENT-REQUIRED header", challenge: decoded };
      }
    } catch {
      // Present but not decodable JSON. Fall through and try the body rather
      // than reporting "no payment info" -- the header exists, we just could
      // not read it, and saying so is the honest report.
    }
  }
  if (body && Array.isArray(body.accepts)) {
    return { from: "body.accepts", challenge: body };
  }
  return { from: "", challenge: null };
}

server.tool(
  "minia2a_check_endpoint",
  "Validate any x402 endpoint for autonomous-agent (Claude Code auto-mode) readiness. Checks 9 signals: HTTP reachability, JSON content-type, payment challenge (canonical PAYMENT-REQUIRED header or legacy x-402-* headers), payment amount, network, recipient, trial info, registration path, and /api/agent-ready handshake. Returns a score (0-100%) with per-check PASS/FAIL detail. Use this before calling a paid endpoint to verify it works with autonomous agents.",
  {
    endpointUrl: z
      .string()
      .describe("The endpoint URL to validate (e.g., 'https://minia2a.uk/x402/gas')"),
  },
  { readOnlyHint: true },
  async ({ endpointUrl }) => {
    const checks: {
      signal: string;
      weight: number;
      credited: number;
      pass: boolean | null;
      detail: string;
    }[] = [];
    // A signal can be partly credited (a 402 endpoint is reachable and speaking
    // x402, but is not answering the call -- half the reachability weight).
    // `credited` is recorded per signal rather than accumulated in a separate
    // total, so the printed report adds up to the printed score. It previously
    // did not: HTTP 200/402 printed PASS at weight 15 while only 7.5 was
    // counted, and the old denominator (115) did not match its own signal list
    // (110) either. Both were silent -- the output looked self-consistent and
    // was not.
    const totalWeight = () => checks.reduce((s, c) => s + c.weight, 0);
    const earnedWeight = () => checks.reduce((s, c) => s + c.credited, 0);
    const push = (
      signal: string,
      weight: number,
      pass: boolean | null,
      detail: string,
      credited?: number
    ) => checks.push({ signal, weight, credited: credited ?? (pass === true ? weight : 0), pass, detail });

    const url = endpointUrl.replace(/\/$/, "");
    const origin = new URL(url).origin;

    // 1. HTTP reachability
    try {
      const probeResp = await fetch(url, {
        // Self-identify with the header, NOT `?probe=1`.
        //
        // minia2a treats `probe=1` as "this caller does not need the guidance
        // payload" and answers with a reduced body: `message`, `nextSteps` and
        // `trialExhausted` are dropped. That is exactly the material the trial
        // and registration signals below grade, so probing that way made both
        // checks fail on every real endpoint no matter how correct it was --
        // the tool was measuring a variant of the resource it had asked for.
        // The header form still marks this call as a probe for the platform's
        // own stats, while the response stays the one a real agent receives.
        //
        // No X-Agent-ID: url is caller-supplied, so this can hit any third-party
        // origin. Our identity is only for minia2a's own endpoints.
        headers: { Accept: "application/json", "X-x402-Probe": "1" },
      });
      const httpOk = probeResp.ok || probeResp.status === 402;
      push(
        "HTTP 200/402",
        15,
        httpOk,
        `HTTP ${probeResp.status}${probeResp.ok ? " OK" : " (reachable, payment required)"}` +
          (httpOk && !probeResp.ok ? " — half credit: reachable and speaking x402, but not answering the call" : ""),
        httpOk ? (probeResp.ok ? 15 : 7.5) : 0
      );

      // 2. JSON Content-Type
      const ct = probeResp.headers.get("content-type") || "";
      const isJson = ct.includes("json");
      push("JSON Content-Type", 5, isJson, ct || "no content-type header");

      // Body is needed by the payment, trial and registration signals below.
      // Parse it once; on failure those signals are recorded as UNKNOWN rather
      // than FAIL, so an endpoint that answers 402 with a non-JSON body is not
      // silently reported as "carries no payment information".
      let body: any = null;
      let bodyErr = "";
      if (isJson) {
        try {
          body = await probeResp.clone().json();
        } catch (e) {
          bodyErr = e instanceof Error ? e.message : "unparseable";
        }
      } else {
        bodyErr = "content-type is not JSON";
      }

      // 3–6. Payment challenge. Canonical form comes from the
      // PAYMENT-REQUIRED header (or the identical body); legacy x-402-*
      // headers are accepted so endpoints built to the older convention are
      // measured on what they do carry, not on which vintage they are.
      const legacyAmount = probeResp.headers.get("x-402-amount");
      const legacyChain = probeResp.headers.get("x-402-chain");
      const legacyPayTo = probeResp.headers.get("x-402-recipient");
      const { from, challenge } = readChallenge(probeResp, body);
      const acc: X402Accept = (challenge?.accepts && challenge.accepts[0]) || {};

      const hasChallenge =
        probeResp.status === 402 && (!!acc.amount || !!acc.network || !!legacyAmount);
      push(
        "Payment challenge",
        15,
        hasChallenge,
        hasChallenge
          ? `HTTP 402, challenge from ${from || "x-402-* headers"}`
          : probeResp.status === 402
          ? "HTTP 402 but no readable accepts[]/x-402-* payment info"
          : `HTTP ${probeResp.status} — no payment challenge to read`
      );

      const rawAmount = acc.amount ?? legacyAmount ?? "";
      const amountOk = /^\d+$/.test(String(rawAmount));
      push(
        "Payment amount",
        10,
        amountOk,
        amountOk
          ? `${rawAmount} (raw units${acc.asset ? `, asset ${acc.asset}` : ""})`
          : rawAmount
          ? `present but not an integer string: ${rawAmount}`
          : "no amount in challenge"
      );

      // The two vocabularies name a chain differently and are judged
      // accordingly: the canonical `accepts[].network` is a CAIP-2 id
      // (eip155:8453), while the legacy x-402-chain header carries a bare name
      // ("base"). Requiring CAIP-2 of both scored legacy endpoints down for
      // using a form that is merely older, not wrong.
      const net = acc.network ?? legacyChain ?? "";
      const netOk = acc.network
        ? /^[a-z0-9-]+:[A-Za-z0-9]+$/.test(String(net))
        : /^[a-z][a-z0-9-]{1,24}$/.test(String(net));
      push(
        "Payment network",
        10,
        netOk,
        netOk
          ? `${net}${acc.network ? " (CAIP-2)" : " (legacy chain name)"}`
          : net
          ? `unrecognised network id: ${net}`
          : "no network in challenge"
      );

      const payTo = acc.payTo ?? legacyPayTo ?? "";
      const payToOk = typeof payTo === "string" && payTo.length >= 16;
      push(
        "Payment recipient",
        10,
        payToOk,
        payToOk ? String(payTo) : payTo ? `too short to be an address: ${payTo}` : "no payTo in challenge"
      );

      // 7. Trial info. Accepts the shape the platform actually emits
      // (`trialExhausted` boolean plus nextSteps/message describing the trial)
      // as well as the older `_trial: {remaining, limit}` block.
      if (body !== null) {
        const trial = body._trial || body.trial || {};
        const counted = trial.remaining !== undefined || trial.limit !== undefined;
        const declared =
          typeof body.trialExhausted === "boolean" ||
          /\btrial\b/i.test(
            [...(Array.isArray(body.nextSteps) ? body.nextSteps : []), body.message || ""].join(" ")
          );
        const hasTrial = counted || declared;
        push(
          "Trial info",
          15,
          hasTrial,
          counted
            ? `remaining: ${trial.remaining}/${trial.limit}${trial.reset ? ", reset: " + trial.reset : ""}`
            : declared
            ? `declared in body (trialExhausted=${body.trialExhausted})`
            : "body does not describe a trial"
        );

        // 8. Registration path. A self-serve route counts: the platform's
        // nextSteps spell out "attach ?wallet=... with X-Wallet-Signature",
        // which is a registration path that needs no account.
        const regPath = body.register || body.registrationUrl || (body._trial && body._trial.register) || "";
        const regHdr = probeResp.headers.get("x-402-register");
        const steps = Array.isArray(body.nextSteps) ? body.nextSteps.join(" ") : "";
        const selfServe = /wallet/i.test(steps) && /(trial|sign|signature)/i.test(steps);
        const hasReg = !!regPath || !!regHdr || selfServe;
        push(
          "Registration path",
          15,
          hasReg,
          regPath
            ? JSON.stringify(regPath).slice(0, 100)
            : regHdr
            ? `header: ${regHdr}`
            : selfServe
            ? "self-serve path described in nextSteps (attach wallet + signature, no account)"
            : "no registration or self-serve wallet path"
        );
      } else {
        push("Trial info", 15, null, `cannot read body: ${bodyErr}`);
        push("Registration path", 15, null, `cannot read body: ${bodyErr}`);
      }
    } catch (e) {
      const why = `Unreachable: ${e instanceof Error ? e.message : "network error"}`;
      push("HTTP 200/402", 15, false, why);
      push("JSON Content-Type", 5, false, "Endpoint unreachable");
      push("Payment challenge", 15, false, "Endpoint unreachable");
      push("Payment amount", 10, false, "Endpoint unreachable");
      push("Payment network", 10, false, "Endpoint unreachable");
      push("Payment recipient", 10, false, "Endpoint unreachable");
      push("Trial info", 15, false, "Endpoint unreachable");
      push("Registration path", 15, false, "Endpoint unreachable");
    }

    // 9. Agent-ready endpoint
    try {
      const arResp = await fetch(`${origin}/api/agent-ready`, {
        headers: { Accept: "application/json" },
      });
      if (arResp.ok) {
        const arBody: any = await arResp.json();
        // Two accepted shapes: the original nested
        // {payment:{chain,token}, registration:{endpoint}} block, and the shape
        // the platform actually serves -- flat readiness fields. Requiring only
        // the nested one made this signal fail on every real minia2a origin.
        const nested =
          arBody.payment && arBody.payment.chain && arBody.payment.token &&
          arBody.registration && arBody.registration.endpoint;
        const flat =
          typeof arBody.status === "string" &&
          (arBody.services !== undefined ||
            arBody.paymentRoutes !== undefined ||
            arBody.facilitator !== undefined ||
            arBody.onchain !== undefined);
        const ready = !!(nested || flat);
        push(
          "Agent-Ready endpoint",
          15,
          ready,
          ready
            ? flat
              ? `status:${arBody.status}, services:${arBody.services ?? "?"}, paymentRoutes:${arBody.paymentRoutes ?? "?"}`
              : `status:${arBody.status}, payment:${arBody.payment?.chain}/${arBody.payment?.token}`
            : `HTTP 200 but no recognisable readiness fields: ${Object.keys(arBody).slice(0, 8).join(",")}`
        );
      } else {
        push("Agent-Ready endpoint", 15, false, `HTTP ${arResp.status} — /api/agent-ready not found`);
      }
    } catch {
      push("Agent-Ready endpoint", 15, false, "unreachable or not JSON");
    }

    const tw = totalWeight();
    const score = tw > 0 ? Math.round((earnedWeight() / tw) * 100) : 0;
    const failed = checks.filter((c) => c.pass === false).map((c) => c.signal);
    const unknown = checks.filter((c) => c.pass === null).map((c) => c.signal);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              endpoint: url,
              score,
              rating:
                score >= 80
                  ? "AUTO-MODE READY"
                  : score >= 50
                  ? "PARTIALLY READY"
                  : "NOT READY",
              summary:
                score >= 80
                  ? "This endpoint has the signals auto-mode agents need to pay autonomously."
                  : score >= 50
                  ? `Partly there — failing: ${failed.join(", ") || "none"}.`
                  : `Failing: ${failed.join(", ") || "none"}.`,
              // No deadline is asserted here. The previous build hardcoded
              // "Aug 14, 2026 (3 days)", which kept reporting three days
              // remaining long after the date had passed.
              scoring: `${earnedWeight()} of ${tw} points (score = round(credited / weight * 100))`,
              checks: checks.map((c) => ({
                signal: c.signal,
                weight: c.weight,
                credited: c.credited,
                result: c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "UNKNOWN",
                detail: c.detail,
              })),
              unknownSignals: unknown,
              nextSteps: [
                "1. Answer HTTP 402 with a payment challenge. Canonical form: a PAYMENT-REQUIRED header carrying base64(JSON) whose accepts[] array has amount (raw units, integer string), asset, network (e.g. eip155:8453) and payTo. The legacy x-402-amount/chain/token/recipient headers are still accepted.",
                "2. Describe the trial in the body: _trial:{remaining, limit, reset}, or a trialExhausted boolean plus nextSteps/message.",
                "3. State how a caller gets access: a register/registrationUrl field, an x-402-register header, or nextSteps that spell out the self-serve wallet+signature path.",
                "4. Serve GET /api/agent-ready returning JSON with a status string plus services/paymentRoutes/facilitator/onchain, or a payment{chain,token} + registration{endpoint} block.",
                "Full guide: https://minia2a.uk/auto-mode-validator.html",
              ],
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`minia2a-mcp v${VERSION} started — x402 marketplace for AI agents`);
}

main().catch((err) => {
  console.error("minia2a-mcp fatal:", err);
  process.exit(1);
});
