
      UPDATE "notification_connections"
      SET "settings" = ("settings" - 'webhookUrl')
        || jsonb_build_object('url', "settings"->'webhookUrl')
      WHERE "type" IN ('webhook', 'gotify', 'ntfy')
        AND "settings" ? 'webhookUrl'
        AND NOT "settings" ? 'url';


      UPDATE "notification_connections"
      SET "settings" = "settings" - 'webhookUrl'
      WHERE "type" IN ('webhook', 'gotify', 'ntfy')
        AND "settings" ? 'webhookUrl';
