UPDATE "cleanup_rules" SET "level" = "criteria"->>'mediaType'
  WHERE "criteria"->>'mediaType' IN ('movie', 'series') AND "level" IN ('movie', 'series');

UPDATE "cleanup_rules" SET "criteria" = "criteria" - 'mediaType' WHERE "criteria" ? 'mediaType';
