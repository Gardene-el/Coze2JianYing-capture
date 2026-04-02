/**
 * Node.js HTTP server — standalone / Docker deployment entry point.
 *
 * Bridges Node.js IncomingMessage → Web Fetch API Request, then dispatches
 * to the same Worker handler used on Cloudflare, with a SQLite-backed D1
 * adapter in place of the real D1 binding.
 *
 * Environment variables:
 *   PORT                 HTTP port to listen on           (default: 8787)
 *   DB_PATH              Path to the SQLite database file (default: ./data/relay.db)
 *   RELAY_SECRET         Bearer token for POST auth       (optional, unset = skip auth)
 *   RECORD_TTL_SECONDS   TTL for recorded calls in s      (default: 604800)
 *   CORS_ORIGINS         Comma-separated allowed origins  (optional)
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { SQLiteD1Database } from "./adapters/d1-sqlite";
// eslint-disable-next-line import/no-relative-packages
import workerHandler from "./index";
import type { Env } from "./types";

// ── Database ──────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? "./data/relay.db";

// Ensure the data directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqliteDb = new SQLiteD1Database(path.resolve(DB_PATH));

// Initialise schema (all statements are idempotent — IF NOT EXISTS)
// When bundled by esbuild, __dirname points to the output directory (dist/).
// schema.sql is copied there during the Docker build, so ../schema.sql
// resolves correctly in both development (src/../) and production (dist/../).
const schemaCandidates = [
  path.join(__dirname, "../schema.sql"), // bundled:  dist/../schema.sql  → /app/schema.sql
  path.join(process.cwd(), "schema.sql"), // fallback: CWD/schema.sql
];
const schemaFile = schemaCandidates.find((p) => fs.existsSync(p));
if (schemaFile) {
  sqliteDb.exec(fs.readFileSync(schemaFile, "utf-8"));
  console.log(`[server] Schema initialised from ${schemaFile}`);
} else {
  console.warn(
    "[server] schema.sql not found — database tables may not exist yet.",
  );
}

// ── Build the Env object ──────────────────────────────────────

// The cast is intentional: SQLiteD1Database implements the D1Database API
// surface actually used by this project at runtime.
const env: Env = {
  // biome-ignore lint/suspicious/noExplicitAny: intentional adapter cast
  DB: sqliteDb as any,
  RELAY_SECRET: process.env.RELAY_SECRET || undefined,
  RECORD_TTL_SECONDS: process.env.RECORD_TTL_SECONDS,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
};

// ── Minimal ExecutionContext stub ─────────────────────────────

const ctx = {
  waitUntil(p: Promise<unknown>): void {
    p.catch((err) => console.error("[ctx.waitUntil]", err));
  },
  passThroughOnException(): void {
    // no-op in Node.js context
  },
};

// ── HTTP server ───────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (nodeReq, nodeRes) => {
  try {
    // Collect the request body
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) {
      chunks.push(chunk as Buffer);
    }
    const bodyBuf = Buffer.concat(chunks);

    // Convert to a Web Fetch API Request
    const url = `http://localhost:${PORT}${nodeReq.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, rawValue] of Object.entries(nodeReq.headers)) {
      if (Array.isArray(rawValue)) {
        for (const v of rawValue) headers.append(key, v);
      } else if (rawValue !== undefined) {
        headers.set(key, rawValue);
      }
    }

    const method = nodeReq.method ?? "GET";
    const webRequest = new Request(url, {
      method,
      headers,
      // GET and HEAD must not carry a body
      body:
        bodyBuf.length > 0 && method !== "GET" && method !== "HEAD"
          ? bodyBuf
          : undefined,
    });

    // Dispatch to the Worker handler
    // biome-ignore lint/suspicious/noExplicitAny: stub types
    const response = await workerHandler.fetch(webRequest, env as any, ctx as any);

    // Forward the response
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    nodeRes.writeHead(response.status, responseHeaders);
    const responseBody = await response.arrayBuffer();
    nodeRes.end(Buffer.from(responseBody));
  } catch (err) {
    console.error("[server] Unhandled error:", err);
    nodeRes.writeHead(500, { "Content-Type": "application/json" });
    nodeRes.end(
      JSON.stringify({ code: 500, message: "Internal Server Error" }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Database  : ${path.resolve(DB_PATH)}`);
  if (!env.RELAY_SECRET) {
    console.warn(
      "[server] RELAY_SECRET is not set — POST requests are unauthenticated",
    );
  }
});

// ── Graceful shutdown ─────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down...");
  server.close(() => {
    sqliteDb.close();
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT received, shutting down...");
  server.close(() => {
    sqliteDb.close();
    process.exit(0);
  });
});
