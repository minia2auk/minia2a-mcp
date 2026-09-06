# minia2a-mcp

MCP server for [minia2a.uk](https://minia2a.uk) — the **x402 micropayment marketplace** for AI agents.

**🚀 Claude Code auto-mode ready (Aug 14, 2026).** Let your AI agent discover, call, and pay for 1,680+ services using the x402 protocol with built-in USDC micropayments. 5 free trial calls per registered wallet (self-custody wallet + EIP-191 signature) — no API keys, no subscriptions, pay-per-call. `.agent-budget` v1.1 support for safe autonomous spending.

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

## Tools (6)

### `minia2a_list_services`
Browse available x402 services. Filter by category or search term.

### `minia2a_get_service`
Get detailed info about a specific service — price, endpoint, schema, docs.

### `minia2a_get_stats`
Platform statistics — total services, agents, transaction volume, uptime.

### `minia2a_register`
Register with a self-custody wallet + EIP-191 signature — get 5 free trial calls to start. If you don't supply a wallet, one is generated for you and the private key returned.

### `minia2a_call_service`
Call any x402 service. Two access paths, in the order the gateway tries them:

1. **Wallet trials** — pass `privateKey` (or set `MINIA2A_PRIVATE_KEY`) for a registered wallet's
   5 free trial calls. The key stays in this process; it only signs
   the per-call message `minia2a trial:<wallet>:<serviceId>:<unixSeconds>`, and just the signature
   goes over the wire. `wallet=` on its own reaches nothing — the signature is what does.
2. **Payment** — when the wallet's trials are spent the tool returns the 402 `accepts[]` array to settle.

The response reports `trialMode` (`wallet` / `ip`) and `trialRemaining` straight from the gateway's
headers, so you can see which path actually paid for the call rather than inferring it.

### `minia2a_check_endpoint` ← NEW in v1.1.3
Validate any x402 endpoint for Claude Code auto-mode readiness (Aug 14, 2026). Checks 9 signals: HTTP reachability, JSON content-type, 4 payment headers (amount/chain/token/recipient), trial info, registration path, and /api/agent-ready handshake. Returns a scored report with per-check PASS/FAIL detail.

## What is minia2a?

[minia2a.uk](https://minia2a.uk) is a marketplace where AI agents buy and sell services from each other. Built on the **x402 protocol** (HTTP 402 Payment Required), every API call includes automatic USDC micropayment — no subscriptions, no API keys, no monthly bills.

- **1,680+ x402 services** — crypto, web, AI, data, and more
- **USDC settlement across 8 chains** — Base, Algorand, and more
- **5 free trial calls per registered wallet** (self-custody wallet + EIP-191 signature)
- **Claude Code auto-mode ready** — `.agent-budget` v1.1 support, machine-readable 402 body

## Claude Code Auto Mode (Aug 14, 2026)

Claude Code auto mode becomes the default on August 14. Agents can now autonomously discover, trial, and pay for APIs — with hard budget caps, classifier safety checks, and machine-readable payment headers.

**minia2a is auto-mode ready:**
- `/api/agent-ready` — machine-readable handshake with payment info, registration endpoint, and quickstart
- 402 body: `accepts[]` array (`amount`/`asset`/`network`/`payTo`/`scheme`) — agent parses full payment instruction (x402 V2)
- `.agent-budget` v1.1 — 7-field autonomous-purchasing controls (per-call / per-task / confirmation / dedupe / settlement / audit)
- 5 free trial calls per registered wallet — try any paid endpoint

```json
{
  "version": "1.1",
  "daily_limit_usdc": 5,
  "max_per_call_usdc": 1,
  "per_task_limit_usdc": 3,
  "confirmation_threshold_usdc": 0.5,
  "idempotency_key": "required",
  "verify_settlement": true,
  "audit_trail": true
}
```

[Quickstart guide →](https://minia2a.uk/blog/prepare-x402-for-auto-mode-august-2026.html)

## What is x402?

x402 is an open protocol that extends HTTP 402 Payment Required for machine-to-machine micropayments. Services declare their price in HTTP response headers, and clients pay in USDC on Base. No intermediaries, no settlement delays. x402 Foundation launched July 2026 under the Linux Foundation with 40+ founding members including Visa, Mastercard, Stripe, and Cloudflare.

Learn more at [x402.org](https://x402.org).

## Ecosystem

minia2a offers multiple integration paths depending on your stack:

| Package | Use Case | Install |
|---------|----------|---------|
| **minia2a-mcp** (this) | MCP server for Claude, Cursor, Codex | `npm i -g minia2a-mcp` |
| [@minia2a/sdk](https://www.npmjs.com/package/@minia2a/sdk) | CLI for @x402/express developers | `npm i -g @minia2a/sdk` |
| [@minia2a/elizaos-plugin-minia2a](https://www.npmjs.com/package/@minia2a/elizaos-plugin-minia2a) | ElizaOS agent plugin | `npm i @minia2a/elizaos-plugin-minia2a` |
| [minia2a](https://www.npmjs.com/package/minia2a) | General-purpose SDK | `npm i minia2a` |

## Links

- [minia2a.uk](https://minia2a.uk) — the marketplace
- [minia2a MCP Server on npm](https://www.npmjs.com/package/minia2a-mcp)
- [MCP Registry](https://registry.modelcontextprotocol.io) — find this server on the official registry

## License

MIT
