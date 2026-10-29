UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb - 'parties.create')::text
       WHERE "permissions"::jsonb ? 'parties.create' AND NOT ("permissions"::jsonb ? 'requests.create');
