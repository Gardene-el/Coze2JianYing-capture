# ── Stage 1: Builder ─────────────────────────────────────────
# Full Node.js image with build tools needed to compile better-sqlite3's
# native bindings and to run esbuild.
FROM node:20-slim AS builder

WORKDIR /app

# Install Python + build tools required by better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (including better-sqlite3 — compiled here)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the standalone Node.js server bundle
COPY . .
RUN npm run build:server


# ── Stage 2: Runtime ─────────────────────────────────────────
# Slim image for the final image — no build tools needed at runtime.
FROM node:20-slim AS runtime

WORKDIR /app

# Copy the compiled native modules (better-sqlite3) from the builder stage.
# We copy all of node_modules so that the native .node file is correctly
# resolved alongside its JS wrapper.
COPY --from=builder /app/node_modules ./node_modules

# Copy the bundled server and the SQL schema
COPY --from=builder /app/dist/server.js ./dist/server.js
COPY schema.sql ./

# Persistent data volume — the SQLite database lives here
VOLUME ["/app/data"]

# ── Configuration ────────────────────────────────────────────
ENV PORT=8787
ENV DB_PATH=/app/data/relay.db
# Set these at runtime (docker run -e / docker-compose env_file):
#   RELAY_SECRET         Bearer token for POST auth (leave empty to disable)
#   RECORD_TTL_SECONDS   TTL in seconds (default: 604800 = 7 days)
#   CORS_ORIGINS         Comma-separated allowed CORS origins

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
