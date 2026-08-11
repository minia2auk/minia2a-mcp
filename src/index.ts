#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MINIA2A_API = "https://minia2a.uk/api";

// ── Types ────────────────────────────────────────────────────────────

interface Service {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  price?: number;
  category?: string;
  tags?: string[];
  credits?: number;
  owner?: string;
}

interface StatsResponse {
  services: number;
  registeredAgents: number;
  totalCalls: number;
  totalVolumeCents: number;
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

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "minia2a",
  version: "1.1.7",
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

    const result = services.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: result.length,
              platform: "minia2a.uk",
              payment: "x402 protocol — per-call USDC micropayments",
              services: result.map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                endpoint: s.endpoint,
                price: s.price ? `${s.price} credits` : "varies",
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
              price: service.price
                ? `${service.price} credits`
                : "credits vary by service",
              category: service.category || "uncategorized",
              tags: service.tags || [],
              how_to_call: `Send an x402 POST to ${service.endpoint} with the required parameters. Add "x402-price: <credits>" and "x402-wallet: <your_wallet>" headers.`,
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
                totalVolume: formatCents(stats.totalVolumeCents),
                totalTransactions: stats.totalTransactions,
                totalRequests: stats.totalRequests.toLocaleString(),
                platformFee: stats.fee,
                uptimeHours: stats.uptime,
              },
              payment: {
                protocol: "x402 (HTTP 402 Payment Required)",
                currency: "USDC on Base",
                wallet: stats.platformWallet,
              },
              links: {
                home: "https://minia2a.uk",
                docs: "https://minia2a.uk/docs",
                github: "https://github.com/minia2a",
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
  "Register for minia2a.uk — creates an auto-generated wallet with 500 FREE credits (~$2.50 value). No signature, no gas, no KYC. After registration, you can call any of the 170+ x402 services with your credits. FREE tier: 15 credits/day.",
  {
    name: z
      .string()
      .describe("A name for your agent (e.g., 'my-trading-bot')"),
  },
  { destructiveHint: true },
  async ({ name }) => {
    try {
      const res = await fetch(`${MINIA2A_API}/v1/register-simple`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "registered",
                  message: "500 free credits loaded. Start calling services!",
                  wallet: data.wallet,
                  credits: 500,
                  value: "~$2.50 USDC",
                  next: "Use minia2a_call_service to start using x402 services. Your credits will be used automatically.",
                  freeDailyCredits: "15 credits/day after initial 500",
                  topUp: "Use minia2a_buy_credits to purchase more (1 USDC = 200 credits)",
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
                  hint: data.hint || "One free account per IP. Try from a different network or generate a wallet manually.",
                  manualRegistration:
                    'Generate wallet: node -e "const ethers=require(\'ethers\'); console.log(new ethers.Wallet.createRandom().address)" then POST /api/v1/register-user {name, wallet} with X-Wallet-Signature',
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

// ── Tool: credits balance ─────────────────────────────────────────────

server.tool(
  "minia2a_credits",
  "Check your credit balance on minia2a.uk. Returns remaining credits, value in USDC, and trial status. Use this to see if you have enough credits before calling a paid service.",
  {
    wallet: z
      .string()
      .optional()
      .describe("Your wallet address to check. If omitted, checks via trial state (IP-based)."),
  },
  { readOnlyHint: true },
  async ({ wallet }) => {
    try {
      const endpoint = wallet
        ? `${MINIA2A_API}/v1/credits?wallet=${wallet}`
        : `${MINIA2A_API}/v1/credits`;
      const res = await fetch(endpoint);
      const data = await res.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                wallet: data.wallet || wallet || "trial (IP-based)",
                credits: data.credits ?? data.remaining ?? "unknown",
                value: data.value || `${((data.credits || 0) / 200).toFixed(2)} USDC`,
                freeTier: data.freeTier || "15 credits/day",
                totalSpent: data.totalSpent || "0",
                totalCalls: data.totalCalls || 0,
                action:
                  data.credits === 0
                    ? "Out of credits! Use minia2a_buy_credits to purchase more (1 USDC = 200 credits)"
                    : "Ready to call services!",
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
                error: err instanceof Error ? err.message : "Unknown error",
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

// ── Tool: buy credits ─────────────────────────────────────────────────

server.tool(
  "minia2a_buy_credits",
  "Purchase more credits on minia2a.uk. Sends USDC on Base chain via x402 protocol. 1 USDC = 200 credits. Minimum purchase: 1 USDC.",
  {
    wallet: z
      .string()
      .describe("Your wallet address that will send the USDC payment"),
    amountUSDC: z
      .number()
      .optional()
      .default(1)
      .describe("Amount of USDC to spend (default 1.0, minimum 1.0)"),
  },
  { destructiveHint: true },
  async ({ wallet, amountUSDC }) => {
    try {
      const res = await fetch(`${MINIA2A_API}/v1/buy-credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, amount: amountUSDC }),
      });
      const data = await res.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: res.status === 200 ? "payment_required" : "info",
                creditsToReceive: amountUSDC * 200,
                amountUSDC,
                chain: "Base",
                platformWallet:
                  data.platformWallet ||
                  "0xf16F0882de08315B438E9f3a2Abfb2d2E5d94ECA",
                instructions: `Send exactly ${amountUSDC} USDC on Base to the platform wallet address. Include your wallet address (${wallet}) in the transaction memo/calldata. After confirmation, credits appear automatically.`,
                autoDetect:
                  "Credits are auto-detected from on-chain USDC transfers. No manual claiming needed.",
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
                error: err instanceof Error ? err.message : "Unknown error",
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
  "Call an x402 service on minia2a.uk. The x402 protocol handles micropayment automatically — you pay per call in USDC. The response includes the service output and payment confirmation.",
  {
    serviceId: z
      .string()
      .describe("The service ID (e.g., 'x402-weather') or full endpoint path"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe("JSON parameters to send to the service"),
    wallet: z
      .string()
      .optional()
      .describe("Your Ethereum wallet address for x402 payment (if you have one)"),
    maxCredits: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum credits you're willing to spend on this call (default 10)"),
  },
  { destructiveHint: true },
  async ({ serviceId, params, wallet, maxCredits }) => {
    const services = await fetchServices();
    const service = services.find(
      (s) =>
        s.id === serviceId ||
        s.name.toLowerCase() === serviceId.toLowerCase() ||
        s.name.toLowerCase().includes(serviceId.toLowerCase()) ||
        serviceId.startsWith("x402-")
    );

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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x402-version": "1.0",
      "x402-max-credits": String(maxCredits),
    };

    if (wallet) {
      headers["x402-wallet"] = wallet;
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });

      // x402: 402 means payment required (needs credits)
      if (res.status === 402) {
        const paymentInfo = await res.text();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "payment_required",
                  service: service.name,
                  message:
                    "This service requires credits. Register at https://minia2a.uk to get free trial credits.",
                  payment_details: paymentInfo,
                  action:
                    "Visit https://minia2a.uk/register to create an account and receive free credits.",
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
                payment: wallet
                  ? `Charged via x402 to ${wallet}`
                  : "No wallet provided — use free credits or register for a wallet",
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
  console.error("minia2a-mcp v1.1.10 started — x402 marketplace for AI agents");
}

main().catch((err) => {
  console.error("minia2a-mcp fatal:", err);
  process.exit(1);
});
