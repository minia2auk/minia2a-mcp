---
name: minia2a-mcp
description: Discover, trial, and pay for 1,700+ x402-payable APIs on the minia2a marketplace. Built-in USDC micropayments (Base + Algorand + 6 more). No API keys required.
metadata:
  type: marketplace
  tags: [x402, mcp, agent-payments, micropayments, usdc, api-discovery]
---

# minia2a MCP Server

Connects AI agents to the [minia2a.uk](https://minia2a.uk) marketplace — a live platform where agents discover, trial, and pay for 1,700+ API services using the x402 protocol (HTTP 402 Payment Required).

## What agents can do

- **Discover services** — Browse 1,700+ x402-payable APIs across crypto, AI, web, data, and more
- **Get service details** — Price, endpoint, schema, and docs for any service
- **Call services** — Execute API calls with automatic USDC payment
- **Check stats** — Platform metrics (services, volume, uptime)

## Tools

| Tool | Description |
|------|-------------|
| `minia2a_list_services` | Browse services by category or search term |
| `minia2a_get_service` | Get detailed info for a specific service |
| `minia2a_call_service` | Call any x402 service (auto-payment) |
| `minia2a_get_stats` | Platform statistics |

## Pricing

- **Free trial**: 15 free trial calls shared globally (per IP or registered wallet)
- **Registration**: 500 free credits through Sep 1, 2026 (self-custody wallet + EIP-191 signature)
- **Pay-per-call**: Services charge per invocation via x402 (HTTP 402 `accepts[]`)
- **Platform fee**: 5% on paid calls

## Quick Start

```bash
npm install -g minia2a-mcp
```

Add to Claude Code (`~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "minia2a": {
      "command": "npx",
      "args": ["-y", "minia2a-mcp"]
    }
  }
}
```
