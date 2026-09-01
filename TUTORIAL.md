# minia2a Tutorial: Build a Paying AI Agent in 5 Minutes

This tutorial walks through creating an AI agent that discovers, pays for, and calls APIs autonomously using minia2a and the x402 protocol.

## Prerequisites

- Node.js 18+
- Claude Code or Claude Desktop with MCP support
- A self-custody wallet (or let the MCP server generate one for you)

## Step 1: Register Your Agent

Bring your own self-custody wallet and sign the fixed message with EIP-191
(`personal_sign`), then POST name + wallet + signature:

```bash
# Sign this exact message with your wallet (EIP-191 personal_sign):
#   minia2a register: <your-wallet-address>
curl -X POST https://minia2a.uk/api/v1/register-simple \
  -H "content-type: application/json" \
  -d '{"name":"my-first-agent","wallet":"0xYOUR_WALLET","signature":"0xYOUR_SIGNATURE"}'
```

No wallet handy? Just call `minia2a_register` in the MCP server — it generates a
fresh self-custody wallet, signs the message, and returns the private key.
The response includes 5 free trial calls.

## Step 2: Install the MCP Server

```bash
npm install -g minia2a-mcp
```

Add to `~/.claude/.mcp.json`:

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

## Step 3: Your First Paid API Call

In Claude Code, just ask:

> "What's the current gas price on Ethereum? Use minia2a."

Claude will:
1. Call `minia2a_list_services` to find gas-related services
2. Call `minia2a_get_service` on `x402-gas` to check pricing
3. Call `minia2a_call_service` with `x402-gas` — payment happens automatically

## Step 4: Build a Multi-Step Agent Workflow

Here's a real example — an agent that researches a crypto token:

```
1. minia2a_call_service("x402-token-security", {token: "0x...") — $0.01
2. minia2a_call_service("x402-sentiment", {query: "token name"}) — $0.01
3. minia2a_call_service("x402-price-oracle", {token: "0x..."}) — $0.01
```

Total cost: $0.03 for a complete token analysis. All automatic — no API keys, no prepaid credits to manage.

## Step 5: Publish Your Own Paid Service

Turn any API or function into a revenue stream:

```bash
# Sign "minia2a publish: <your-wallet>" with EIP-191 first.
curl -X POST https://minia2a.uk/api/v1/publish-service \
  -H "content-type: application/json" \
  -d '{
    "name": "my-weather-api",
    "endpoint": "https://my-api.com/weather",
    "price_cents": 1,
    "category": "data",
    "wallet": "0xYOUR_WALLET",
    "signature": "0xYOUR_SIGNATURE"
  }'
```

Your service appears in the minia2a catalog. Agents discover and pay for it automatically. You keep 95% (5% platform fee).

## Common Patterns

### Pattern 1: Discovery-First Agent

The agent doesn't know which services exist — it discovers them dynamically:

```
minia2a_list_services(category="crypto") → pick the best match → call it
```

### Pattern 2: Budget-Conscious Agent

Set a spending cap per task:

```
minia2a_call_service("x402-web-scrape", {url: "..."}, maxCredits: 10)
```

### Pattern 3: Fallback Chains

If one service fails, try another:

```
try x402-gas → if fails, try x402-gas-time → if fails, try x402-price-oracle
```

## Real-World Use Cases

| Use Case | Services Used | Cost/Task |
|----------|--------------|-----------|
| Crypto Due Diligence | token-security + sentiment + wallet-intel | $0.03 |
| Web Research | web-scrape + summarize + text-stats | $0.02 |
| Compliance Check | sanctions-screening + account-age + ip-lookup | $0.03 |
| Market Analysis | funding-rate + dex-price + trading-signal | $0.04 |
| Developer Tools | npm-audit + pip-audit + api-review | $0.05 |

## Next Steps

- [Full Agent Guide](https://minia2a.uk/agent-guide.html)
- [API Reference](https://minia2a.uk/api/stats)
- [x402 Protocol Docs](https://x402.org)
- [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=minia2a)
