# minia2a MCP server — x402 pay-per-call marketplace
# Multi-stage build: compiles the TypeScript source, then runs the MCP
# server over stdio (no ports exposed — MCP stdio transport).
#
# Usage:
#   docker build -t minia2a-mcp .
#   docker run -i --rm minia2a-mcp

# --- build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Compile TypeScript -> dist/.
COPY src ./src
RUN npm run build

# --- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Built server + entrypoint.
COPY --from=build /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
