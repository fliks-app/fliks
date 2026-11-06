CREATE TABLE "oidc_providers" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "issuer" text NOT NULL,
  "clientId" text NOT NULL,
  "clientSecret" text,
  "caPem" text,
  "scope" text NOT NULL DEFAULT 'openid profile email',
  "prompt" text,
  "usernameClaim" text NOT NULL DEFAULT 'preferred_username',
  "groupsClaim" text,
  "allowedGroups" text[] NOT NULL DEFAULT '{}',
  "adminGroups" text[] NOT NULL DEFAULT '{}',
  "autoRegister" boolean NOT NULL DEFAULT false,
  "matchByEmail" boolean NOT NULL DEFAULT false,
  "endSessionAtProvider" boolean NOT NULL DEFAULT false,
  "accountUrl" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "position" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "oidc_role_mappings" (
  "providerId" integer NOT NULL REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "group" text NOT NULL,
  "roleId" integer NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  PRIMARY KEY ("providerId", "group")
);
CREATE INDEX "IDX_oidc_role_mappings_roleId" ON "oidc_role_mappings" ("roleId");

CREATE TABLE "user_identities" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "providerId" integer NOT NULL REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "email" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastLoginAt" timestamptz,
  CONSTRAINT "UQ_user_identities_provider_subject" UNIQUE ("providerId", "subject"),
  CONSTRAINT "UQ_user_identities_user_provider" UNIQUE ("userId", "providerId")
);

CREATE TABLE "oidc_logins" (
  "id" serial PRIMARY KEY,
  "providerId" integer NOT NULL REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "state" text NOT NULL UNIQUE,
  "nonce" text NOT NULL,
  "returnTo" text NOT NULL,
  "linkUserId" integer REFERENCES "users"("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "IDX_oidc_logins_providerId" ON "oidc_logins" ("providerId");
CREATE INDEX "IDX_oidc_logins_linkUserId" ON "oidc_logins" ("linkUserId");

ALTER TABLE "sessions"
  ADD COLUMN "providerId" integer REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  ADD COLUMN "subject" text,
  ADD COLUMN "sid" text,
  ADD COLUMN "idToken" text;
CREATE INDEX "IDX_sessions_provider_sid" ON "sessions" ("providerId", "sid");
CREATE INDEX "IDX_sessions_provider_subject" ON "sessions" ("providerId", "subject");
