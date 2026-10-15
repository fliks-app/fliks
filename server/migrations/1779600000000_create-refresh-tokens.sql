
      CREATE TABLE "refresh_tokens" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "userId" int NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "userAgent" varchar(255),
        "lastUsedAt" timestamptz,
        CONSTRAINT "FK_refresh_tokens_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      );


      CREATE INDEX "IDX_refresh_tokens_tokenHash"
        ON "refresh_tokens" ("tokenHash");


      CREATE INDEX "IDX_refresh_tokens_userId"
        ON "refresh_tokens" ("userId");
