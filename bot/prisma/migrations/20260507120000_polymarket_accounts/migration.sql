-- CreateTable
CREATE TABLE "PolymarketAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "passphrase" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "funderAddress" TEXT NOT NULL,
    "isActive" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
