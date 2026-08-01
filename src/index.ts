#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MINIA2A_API = "https://minia2a.uk/api";

// ── Helpers ──────────────────────────────────────────────────────────

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
  agents: number;
  registeredAgents: number;
  totalCalls: number;
  totalVolumeCents: number;
  totalTransactions: number;
  uptime: number;
  totalRequests: number;
  fee: string;
  platformWallet: string;
}

let servicesCache: { data: Service[]; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 minutes

async function fetchServices(): Promise<Service[]> {
  if (servicesCache && Date.now() - servicesCache.ts < CACHE_TTL) {
    return servicesCache.data;
  }
  const res = await fetch(`${MINIA2A_API}/services`);
  if (!res.ok) throw new Error(`minia2a API returned ${res.status}`);
  const data = (await res.json()) as Service[];
  servicesCache = { data, ts: Date.now() };
  return data;
}

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${MINIA2A_API}/stats`);
  if (!res.ok) throw new Error(`minia2a API returned ${res.status}`);
  return (await res.json()) as StatsResponse;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)} USDC`;
}

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "minia2a",
  version: "1.0.0",
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
                suggestion: "Check that the service endpoint is reachable and try again.",
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

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("minia2a-mcp v1.0.0 started — x402 marketplace for AI agents");
}

main().catch((err) => {
  console.error("minia2a-mcp fatal:", err);
  process.exit(1);
});
