#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Wallet } from "ethers";
import { createRequire } from "node:module";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

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

let servicesCache: { data: Service[]; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 minutes

async function fetchServices(): Promise<Service[]> {
  if (servicesCache && Date.now() - servicesCache.ts < CACHE_TTL) {
    return servicesCache.data;
  }
  const res = await fetch(`${MINIA2A_API}/services`);
  if (!res.ok) throw new Error(`minia2a API returned ${res.status}`);
  const json = await res.json();
  const data = (json.services || json) as Service[];
  servicesCache = { data, ts: Date.now() };
  return data;
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${MINIA2A_API}/stats`);
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
    headers: { "Content-Type": "application/json" },
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
              how_to_call: `Call ${service.endpoint} with a registered wallet (signed via privateKey) to use its 5 free trial calls, or call anonymously to hit the paid 402 path. When trials run out you get HTTP 402 with an accepts[] payment array — pay in USDC and retry with a PAYMENT-SIGNATURE header (x402 V2).`,
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
  "Register for minia2a.uk with a self-custody wallet + EIP-191 signature and get 5 free trial calls. If you don't provide a wallet+signature, this tool generates a fresh wallet, signs 'minia2a register: <your-wallet>' with EIP-191, registers it, and returns the private key — store it, the platform never holds it. 5 free trial calls per registered wallet across all services.",
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
                    "5 free trial calls per registered wallet across all services.",
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
  "Call an x402 service on minia2a.uk. Three access paths: (1) omit everything for the paid 402 path (register a wallet for 5 free trial calls); (2) pass privateKey (or set MINIA2A_PRIVATE_KEY) for your registered wallet's own 5 trials — the key never leaves this process, it only signs the per-call trial message; (3) when both are exhausted the endpoint returns HTTP 402 with a machine-readable accepts[] array — pay in USDC and retry with a PAYMENT-SIGNATURE header (x402 V2). Set autoPay:true together with privateKey to have a 402 paid automatically in USDC on Base and the call retried — the wallet must hold USDC or the call still returns payment_required (never charges silently). Note that wallet= on its own does NOT reach the wallet bucket; the signature is what does.",
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
      .describe("Your registered self-custody wallet address (0x...). Without privateKey this alone does not draw on the wallet's trial bucket."),
    privateKey: z
      .string()
      .optional()
      .describe("Private key of the registered wallet, used locally to sign the trial message (EIP-191). Never transmitted — only the resulting signature is sent. Falls back to the MINIA2A_PRIVATE_KEY env var."),
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
                    "1. Register for 5 free trial calls: minia2a_register (signs 'minia2a register: <wallet>' with EIP-191).",
                    "2. Or pay per call: send USDC to the payTo address in accepts[0], then retry with a PAYMENT-SIGNATURE header (x402 V2).",
                  ],
                  howToProceed: trialSigner
                    ? `Signed as ${trialSigner}. A 402 here means either this wallet's 5 trials are spent, or the wallet is not registered — run minia2a_register first, then retry.`
                    : wallet
                      ? "wallet= alone does not reach the wallet trial bucket. Pass privateKey (or set MINIA2A_PRIVATE_KEY) so the call can be signed, or pay per call."
                      : "No registered wallet trials left. Run minia2a_register, then call again with privateKey to use the wallet's own 5 trials.",
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
                      ? "Registered wallet trial used."
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

server.tool(
  "minia2a_check_endpoint",
  "Validate any x402 endpoint for Claude Code auto-mode readiness (Aug 14, 2026). Checks 9 signals: HTTP reachability, JSON content-type, 4 payment headers (x-402-amount/chain/token/recipient), trial info, registration path, and /api/agent-ready handshake. Returns a score (0-100%) with per-check PASS/FAIL detail. Use this before calling a paid endpoint to verify it works with autonomous agents.",
  {
    endpointUrl: z
      .string()
      .describe("The endpoint URL to validate (e.g., 'https://minia2a.uk/x402/gas')"),
  },
  { readOnlyHint: true },
  async ({ endpointUrl }) => {
    const checks: { signal: string; weight: number; pass: boolean | null; detail: string }[] = [];
    let earnedWeight = 0;
    const totalWeight = 115;

    const url = endpointUrl.replace(/\/$/, "");
    const origin = new URL(url).origin;

    // 1. HTTP reachability
    try {
      const probeResp = await fetch(`${url}?probe=1`, {
        headers: { Accept: "application/json" },
      });
      const httpOk = probeResp.ok || probeResp.status === 402;
      checks.push({
        signal: "HTTP 200/402",
        weight: 15,
        pass: httpOk,
        detail: `HTTP ${probeResp.status}${probeResp.ok ? " OK" : " (payment required or error)"}`,
      });
      if (httpOk) earnedWeight += probeResp.ok ? 15 : 7.5;

      // 2. JSON Content-Type
      const ct = probeResp.headers.get("content-type") || "";
      const isJson = ct.includes("json");
      checks.push({
        signal: "JSON Content-Type",
        weight: 5,
        pass: isJson,
        detail: ct || "no content-type header",
      });
      if (isJson) earnedWeight += 5;

      // 3–6. Payment headers
      for (const [signal, hdr, w] of [
        ["x-402-amount", "x-402-amount", 15],
        ["x-402-chain", "x-402-chain", 10],
        ["x-402-token", "x-402-token", 10],
        ["x-402-recipient", "x-402-recipient", 10],
      ] as const) {
        const val = probeResp.headers.get(hdr);
        checks.push({
          signal,
          weight: w,
          pass: !!val,
          detail: val || "header missing",
        });
        if (val) earnedWeight += w;
      }

      // 7. Trial info
      if (isJson) {
        try {
          const body = await probeResp.clone().json();
          const trial = (body as any)._trial || (body as any).trial || {};
          const hasTrial = trial.remaining !== undefined || trial.limit !== undefined;
          checks.push({
            signal: "Trial info (_trial)",
            weight: 15,
            pass: hasTrial,
            detail: hasTrial
              ? `remaining: ${trial.remaining}/${trial.limit}${trial.reset ? ", reset: " + trial.reset : ""}`
              : "No _trial in body",
          });
          if (hasTrial) earnedWeight += 15;

          // 8. Registration path
          const regPath =
            (body as any).register ||
            (body as any).registrationUrl ||
            ((body as any)._trial && (body as any)._trial.register) ||
            "";
          const regHdr = probeResp.headers.get("x-402-register");
          const hasReg = !!regPath || !!regHdr;
          checks.push({
            signal: "Registration path",
            weight: 15,
            pass: hasReg,
            detail: regPath
              ? JSON.stringify(regPath).slice(0, 100)
              : regHdr
              ? `header: ${regHdr}`
              : "No registration info",
          });
          if (hasReg) earnedWeight += 15;
        } catch {
          checks.push({
            signal: "Trial info (_trial)",
            weight: 15,
            pass: false,
            detail: "Body is not valid JSON",
          });
          checks.push({
            signal: "Registration path",
            weight: 15,
            pass: false,
            detail: "Cannot parse body",
          });
        }
      }
    } catch (e) {
      checks.push(
        {
          signal: "HTTP 200/402",
          weight: 15,
          pass: false,
          detail: `Unreachable: ${e instanceof Error ? e.message : "network error"}`,
        },
        { signal: "JSON Content-Type", weight: 5, pass: false, detail: "Endpoint unreachable" },
        { signal: "x-402-amount", weight: 15, pass: false, detail: "Endpoint unreachable" },
        { signal: "x-402-chain", weight: 10, pass: false, detail: "Endpoint unreachable" },
        { signal: "x-402-token", weight: 10, pass: false, detail: "Endpoint unreachable" },
        { signal: "x-402-recipient", weight: 10, pass: false, detail: "Endpoint unreachable" },
        { signal: "Trial info (_trial)", weight: 15, pass: false, detail: "Endpoint unreachable" },
        { signal: "Registration path", weight: 15, pass: false, detail: "Endpoint unreachable" }
      );
    }

    // 9. Agent-ready endpoint
    try {
      const arResp = await fetch(`${origin}/api/agent-ready`, {
        headers: { Accept: "application/json" },
      });
      if (arResp.ok) {
        const arBody: any = await arResp.json();
        const hasPayment =
          arBody.payment && arBody.payment.chain && arBody.payment.token;
        const hasReg =
          arBody.registration && arBody.registration.endpoint;
        checks.push({
          signal: "Agent-Ready endpoint",
          weight: 15,
          pass: hasPayment && hasReg,
          detail: `status:${arBody.status}, payment:${arBody.payment?.chain || "?"}/${arBody.payment?.token || "?"}`,
        });
        if (hasPayment && hasReg) earnedWeight += 15;
      } else {
        checks.push({
          signal: "Agent-Ready endpoint",
          weight: 15,
          pass: false,
          detail: `HTTP ${arResp.status} — /api/agent-ready not found`,
        });
      }
    } catch {
      checks.push({
        signal: "Agent-Ready endpoint",
        weight: 15,
        pass: false,
        detail: "unreachable or not JSON",
      });
    }

    const score = Math.round((earnedWeight / totalWeight) * 100);
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
                  ? "Add missing 402 headers + registration info before Aug 14."
                  : "Endpoint needs payment headers, trial info, and registration path.",
              autoModeDeadline: "Aug 14, 2026 (3 days)",
              checks: checks.map((c) => ({
                signal: c.signal,
                weight: c.weight,
                result: c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "UNKNOWN",
                detail: c.detail,
              })),
              nextSteps: [
                "1. Add x-402-amount, x-402-chain, x-402-token, x-402-recipient headers to 402 responses",
                "2. Include _trial: {remaining, limit, reset} in JSON body",
                "3. Add x-402-register header or register field in body",
                "4. Create GET /api/agent-ready returning JSON with payment + registration",
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
