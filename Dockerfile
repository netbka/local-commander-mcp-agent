FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY packages ./packages
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
LABEL io.modelcontextprotocol.server.name="io.github.netbka/local-commander-mcp-agent" \
      org.opencontainers.image.source="https://github.com/netbka/local-commander-mcp-agent" \
      org.opencontainers.image.description="Self-hosted MCP server for controlled local development access" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace /home/node/.local-commander \
  && chown -R node:node /workspace /home/node/.local-commander
WORKDIR /app
ENV NODE_ENV=production \
    LCMCP_ROOTS=/workspace \
    LCMCP_CONFIG=/home/node/.local-commander/config.json \
    LCMCP_OAUTH_STATE_PATH=/home/node/.local-commander/oauth.json \
    LCMCP_HOST=0.0.0.0
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages ./packages
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--stdio"]
