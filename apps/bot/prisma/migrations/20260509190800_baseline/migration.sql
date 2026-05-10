-- Baseline: full schema (replaces prior incremental migrations).
-- Table order respects FK dependencies for SQLite.

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sport" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sxEventId" TEXT,
    "polyEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CanonicalBet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "betType" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "line" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanonicalBet_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL,
    "betType" TEXT NOT NULL DEFAULT '1x2',
    "line" REAL,
    "mainLine" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "externalId" TEXT,
    "currentOdds" REAL NOT NULL,
    "liquidityDepth" REAL NOT NULL,
    "liquidityLevels" TEXT,
    "lastUpdated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canonicalBetId" TEXT,
    CONSTRAINT "Outcome_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Outcome_canonicalBetId_fkey" FOREIGN KEY ("canonicalBetId") REFERENCES "CanonicalBet" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonical" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "league" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "requestedSize" REAL NOT NULL,
    "executedSize" REAL,
    "requestedOdds" REAL NOT NULL,
    "fillOdds" REAL,
    "platform" TEXT NOT NULL,
    "txHash" TEXT,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    CONSTRAINT "Trade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "Outcome" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotConfig" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PolymarketAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "passphrase" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "funderAddress" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RiskPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL DEFAULT 'polymarket',
    "outcomeId" TEXT,
    "tokenId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sideLabel" TEXT NOT NULL,
    "avgEntryCents" REAL NOT NULL,
    "sizeShares" REAL NOT NULL,
    "costUsd" REAL NOT NULL,
    "highWaterCents" REAL NOT NULL,
    "stopLossPct" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'bot',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RiskPosition_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "Outcome" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RiskAppliedClobTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RiskTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "positionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RiskTask_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "RiskPosition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_platform_externalId_key" ON "Market"("platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalBet_eventId_key_key" ON "CanonicalBet"("eventId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TeamAlias_platform_alias_league_key" ON "TeamAlias"("platform", "alias", "league");

-- CreateIndex
CREATE INDEX "RiskPosition_status_idx" ON "RiskPosition"("status");

-- CreateIndex
CREATE INDEX "RiskPosition_tokenId_idx" ON "RiskPosition"("tokenId");

-- CreateIndex
CREATE INDEX "RiskTask_status_nextRunAt_idx" ON "RiskTask"("status", "nextRunAt");
