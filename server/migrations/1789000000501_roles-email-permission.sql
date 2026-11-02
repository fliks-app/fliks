-- Mailing books is opt-in: only the roles that already hold every core permission get it.
UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb || '["books.email"]'::jsonb)::text
       WHERE "permissions"::jsonb ?& ARRAY['media.read', 'media.create', 'media.edit', 'media.delete',
               'media.grab', 'livetv.read', 'requests.create', 'requests.manage', 'subtitles.manage',
               'settings.access', 'users.manage', 'roles.manage']
         AND NOT ("permissions"::jsonb ? 'books.email');
