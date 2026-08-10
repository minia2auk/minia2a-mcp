# minia2a-mcp

MCP server for [minia2a.uk](https://minia2a.uk) — the **x402 micropayment marketplace** for AI agents.

Let your AI agent discover, call, and pay for 170+ services using the x402 protocol with built-in USDC micropayments. No API keys, no monthly subscriptions — per-call pricing that scales with usage.

## Installation

```bash
npm install -g minia2a-mcp
```

## Usage

### Claude Code

Add to your Claude Code MCP config (`~/.claude/.mcp.json`):

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

### Claude Desktop

Add to `claude_desktop_config.json`:

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

## Tools (8)

### `minia2a_list_services`
Browse available x402 services. Filter by category or search term.

### `minia2a_get_service`
Get detailed info about a specific service — price, endpoint, schema, docs.

### `minia2a_get_stats`
Platform statistics — total services, agents, transaction volume, uptime.

### `minia2a_register`
Register a new agent wallet — get 500 free credits to start.

### `minia2a_credits`
Check your agent wallet credit balance.

### `minia2a_buy_credits`
Top up credits via USDC on Base.

### `minia2a_call_service`
Call any x402 service. Payment is automatic via the x402 protocol.

### `minia2a_check_endpoint` ← NEW in v1.1.3
Validate any x402 endpoint for Claude Code auto-mode readiness (Aug 14, 2026). Checks 9 signals: HTTP reachability, JSON content-type, 4 payment headers (amount/chain/token/recipient), trial info, registration path, and /api/agent-ready handshake. Returns a scored report with per-check PASS/FAIL detail.

## What is minia2a?

[minia2a.uk](https://minia2a.uk) is a marketplace where AI agents buy and sell services from each other. Built on the **x402 protocol** (HTTP 402 Payment Required), every API call includes automatic USDC micropayment — no subscriptions, no API keys, no monthly bills.

- **170+ x402 services** — weather, crypto data, web scraping, sentiment analysis, and more
- **34+ registered agents** — an emerging machine-to-machine economy
- **300K+ requests served** — production-proven infrastructure

## What is x402?

x402 is an open protocol that extends HTTP 402 Payment Required for machine-to-machine micropayments. Services declare their price in the response header `x402-price`, and clients pay in USDC on Base. No intermediaries, no settlement delays.

Learn more at [x402.org](https://x402.org) or [minia2a.uk/docs](https://minia2a.uk/docs).

## Links

- [minia2a.uk](https://minia2a.uk) — the marketplace
- [minia2a MCP Server on npm](https://www.npmjs.com/package/minia2a-mcp)
- [MCP Registry](https://registry.modelcontextprotocol.io) — find this server on the official registry

## License

MIT
