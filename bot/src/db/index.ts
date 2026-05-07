import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

// This file lives at bot/src/db — DB file is at bot/prisma/dev.db (not bot/src/prisma).
const dbPath = path.resolve(__dirname, "..", "..", "prisma", "dev.db");
const adapter = new PrismaLibSql({ url: `file:${dbPath}` });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** True when this process loaded a Prisma bundle that includes 风控 models (see schema generator `output`). */
function bundleHasRiskModels(): boolean {
  const mn = Prisma.ModelName as Record<string, string> | undefined;
  return mn?.RiskTask === "RiskTask" && mn?.RiskPosition === "RiskPosition";
}

function clientHasRiskDelegates(client: PrismaClient): boolean {
  return typeof (client as unknown as { riskTask?: { findMany?: unknown } }).riskTask?.findMany === "function";
}

function createPrisma(): PrismaClient {
  return new PrismaClient({ adapter });
}

/** Production: one client per process (no global). Dev: prefer global singleton when it matches current schema. */
let productionClient: PrismaClient | undefined;

/**
 * Always returns a PrismaClient that includes the current schema (e.g. RiskTask).
 * ts-node-dev can leave a stale `global.prisma` across reloads — we drop it when delegates are missing.
 */
export function getPrisma(): PrismaClient {
  if (!bundleHasRiskModels()) {
    throw new Error(
      "[db] Prisma JS bundle is missing RiskTask/RiskPosition. Run: cd bot && npx prisma generate — then restart.",
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    const g = globalForPrisma.prisma;
    if (g && clientHasRiskDelegates(g)) return g;
    if (g) {
      void g.$disconnect().catch(() => {});
      delete globalForPrisma.prisma;
    }
  } else if (productionClient && clientHasRiskDelegates(productionClient)) {
    return productionClient;
  } else if (productionClient) {
    void productionClient.$disconnect().catch(() => {});
    productionClient = undefined;
  }

  const client = createPrisma();
  if (!clientHasRiskDelegates(client)) {
    void client.$disconnect().catch(() => {});
    throw new Error(
      "[db] PrismaClient instance has no riskTask delegate (stale or wrong client). Run: cd bot && npx prisma generate — then restart.",
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client;
  } else {
    productionClient = client;
  }
  return client;
}

/**
 * Lazy proxy so modules loaded before `prisma generate` / hot-reload still resolve the current client
 * on each property access (`prisma.riskTask`, `$connect`, etc.).
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: string | symbol) {
    const p = getPrisma();
    const value = (p as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(p);
    }
    return value;
  },
}) as PrismaClient;
