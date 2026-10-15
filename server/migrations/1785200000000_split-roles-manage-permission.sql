UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb || '["roles.manage"]'::jsonb)::text
       WHERE "permissions"::jsonb ? 'users.manage'
         AND NOT ("permissions"::jsonb ? 'roles.manage');
