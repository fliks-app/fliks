UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb
           || CASE WHEN "permissions"::jsonb ? 'parties.create' THEN '[]'::jsonb ELSE '["parties.create"]'::jsonb END
           || CASE WHEN "permissions"::jsonb ? 'parties.read_public' THEN '[]'::jsonb ELSE '["parties.read_public"]'::jsonb END
           || CASE WHEN "permissions"::jsonb ?& ARRAY['media.read', 'media.create', 'media.edit', 'media.delete',
                       'media.grab', 'livetv.read', 'requests.create', 'requests.manage', 'subtitles.manage',
                       'settings.access', 'users.manage', 'roles.manage']
                    AND NOT ("permissions"::jsonb ? 'parties.manage')
                   THEN '["parties.manage"]'::jsonb ELSE '[]'::jsonb END)::text;
