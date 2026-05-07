import { prisma } from './db';

/** In-memory mirror of `BotConfig` — refreshed at startup and after each PUT `/api/config/:key`. */
let cache: Record<string, string> = {};

export async function refreshBotConfigCache(): Promise<void> {
  const rows = await prisma.botConfig.findMany();
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getBotConfigCached(key: string): string | undefined {
  return cache[key];
}
