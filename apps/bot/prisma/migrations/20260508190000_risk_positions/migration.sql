-- CreateTable
CREATE TABLE "RiskPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL DEFAULT 'polymarket',
    "outcomeId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sideLabel" TEXT NOT NULL,
    "avgEntryCents" REAL NOT NULL,
    "sizeShares" REAL NOT NULL,
    "costUsd" REAL NOT NULL,
    "highWaterCents" REAL NOT NULL,
    "stopLossPct" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RiskPosition_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "Outcome" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
CREATE INDEX "RiskPosition_status_idx" ON "RiskPosition"("status");

-- CreateIndex
CREATE INDEX "RiskTask_status_nextRunAt_idx" ON "RiskTask"("status", "nextRunAt");
