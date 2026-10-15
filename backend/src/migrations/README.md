# Database migrations (frozen)

This folder is frozen: no new TypeORM migrations. Schema changes go to
`server/migrations` (sqlx), applied by `fliks-server` at boot. Nest runs with
`synchronize: false` and `migrationsRun: false` in every environment.

Write the sqlx migration and update the Nest entity in the same PR.
