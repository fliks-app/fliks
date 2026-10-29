ALTER TABLE "watch_parties" ADD COLUMN "hostId" int NULL;
ALTER TABLE "watch_parties"
  ADD CONSTRAINT "FK_watch_parties_host" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE SET NULL;
