import { prisma } from './db';
import { getBotConfigCached, refreshBotConfigCache } from './botConfigCache';
import { config } from './config';

export const ONBOARDING_CONFIG_KEY = 'onboardingComplete';

/**
 * First-time DB: no row → `false` (show setup wizard).
 * Upgrade from older builds: already have events or Polymarket accounts → `true` (do not block).
 */
export async function ensureOnboardingDefault(): Promise<void> {
  if (config.READ_ONLY_MODE) {
    await prisma.botConfig.upsert({
      where: { key: ONBOARDING_CONFIG_KEY },
      create: { key: ONBOARDING_CONFIG_KEY, value: 'true' },
      update: { value: 'true' },
    });
    await refreshBotConfigCache();
    return;
  }

  const row = await prisma.botConfig.findUnique({ where: { key: ONBOARDING_CONFIG_KEY } });
  if (row) {
    return;
  }
  const hasLegacyUse =
    (await prisma.event.findFirst({ select: { id: true } })) != null ||
    (await prisma.polymarketAccount.findFirst({ select: { id: true } })) != null;
  await prisma.botConfig.create({
    data: { key: ONBOARDING_CONFIG_KEY, value: hasLegacyUse ? 'true' : 'false' },
  });
  await refreshBotConfigCache();
}

export function isOnboardingCompleteCached(): boolean {
  return getBotConfigCached(ONBOARDING_CONFIG_KEY)?.trim() === 'true';
}

export async function readNeedsOnboarding(): Promise<boolean> {
  const row = await prisma.botConfig.findUnique({ where: { key: ONBOARDING_CONFIG_KEY } });
  return row?.value?.trim() !== 'true';
}
