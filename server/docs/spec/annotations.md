# Spec: reader annotations (bookmarks and highlights)

Scope: what a reader keeps of a text item besides its position: bookmarks, highlights and the notes written on them. The position itself is the playback state (`item-delivery.md` rules 18-21). Annotations belong to one user and one item, are private, and are written by the web reader only (no Kobo or KOReader mapping).

## Storage

1. Table `annotations`: `id` serial, `userId` and `itemId` (`NOT NULL`, FK `ON DELETE CASCADE` to `users` and `items`), `kind` (`bookmark` or `highlight`, `CHECK`), `colour` (`yellow`, `green`, `blue`, `pink`, `CHECK`; `NULL` for a bookmark, set for a highlight), `note` text (`NOT NULL`, default empty), `locator` jsonb (`NOT NULL`, a JSON object), `excerpt` text (`NOT NULL`, default empty), `createdAt` and `updatedAt` timestamptz (`set_updated_at` trigger).
2. Non-partial indexes led by the FK columns: `(userId, itemId, createdAt)` and `(itemId)`.
3. Deleting a user or an item deletes its annotations.

## Routes

| Route | Answer |
|---|---|
| `GET /api/items/:itemId/annotations` | 200, the caller's annotations of the item, oldest first (`createdAt`, then `id`) |
| `POST /api/items/:itemId/annotations` | 201, the created annotation |
| `PATCH /api/annotations/:id` | 200, the updated annotation |
| `DELETE /api/annotations/:id` | 204 |

Every route needs `media.read` (`Authed`: 401, then 403).

## Rules

4. An annotation on the wire is `{ id, itemId, kind, colour, note, locator, excerpt, createdAt, updatedAt }` (named columns, `colour` null for a bookmark).
5. The item must be of a `text` edition whose media sits in a library the caller can read (`libraries::accessible_library_ids`). A missing item, a non-text item and an unreadable one all answer 404 `Item #<id> not found` after the same lookup.
6. `POST` body `{ kind, colour?, note?, locator, excerpt? }`, unknown keys 400. `kind` is `bookmark` or `highlight`; a highlight needs a `colour` and a bookmark takes none (400 otherwise). `locator` must be a JSON object whose serialised form is at most 8 KiB (the limit of `playback_states.locator`), else 400. `note` is at most 4000 characters and `excerpt` at most 2000 (400 beyond). A bookmark carries no `note`.
7. A user holds at most 2000 annotations per item; the next `POST` is 409 `Too many annotations`.
8. `PATCH` body `{ colour?, note? }`, unknown keys 400, at least one key. `colour` applies to a highlight only (a bookmark: 400) and `note` to a highlight only. Nothing else is editable: the locator and the excerpt are those of the creation.
9. `PATCH` and `DELETE` act on the caller's own annotation only: another user's annotation, a missing one and one whose item the caller can no longer read are 404 `Annotation #<id> not found`.
10. `:itemId` and `:id` follow the canonical-integer rule of `PathParams` (400 otherwise).
