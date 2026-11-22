-- A plugin foreign key into `public` runs core deletes' cascades and triggers as the core login.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS rel
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class fcl ON fcl.oid = con.confrelid
      JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
     WHERE con.contype = 'f' AND ns.nspname LIKE 'plugin\_%' AND fns.nspname = 'public'
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.rel, r.conname);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'could not drop % on %: %', r.conname, r.rel, SQLERRM;
    END;
  END LOOP;
END $$;
