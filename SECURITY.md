# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in minia2a-mcp, please report it by opening an issue at:

https://github.com/minia2a-org/minia2a-mcp/issues

We take all security reports seriously and will respond as quickly as possible.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | ✅                 |

## Security Model

minia2a-mcp is an MCP server that connects AI agents to the minia2a.uk marketplace. Key security considerations:

- **API Communication**: All requests to minia2a.uk use HTTPS.
- **Payment Security**: Payments are handled via the x402 protocol with USDC on Base. No private keys are stored or transmitted by this MCP server.
- **Input Validation**: Service parameters are validated server-side before execution.
- **Rate Limiting**: Trial calls are limited per endpoint to prevent abuse.

## Disclosure Policy

We follow responsible disclosure. Please allow up to 72 hours for an initial response before public disclosure.
