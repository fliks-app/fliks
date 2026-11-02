# Spec: e-mail devices and "Send to…"

Scope: mailing the file of a book edition to an e-reader (Kindle, Kobo, PocketBook or any address): the admin's SMTP settings, the per-user devices, the send and its limits (`books-audiobooks` plan 3.9, item 2). Mail goes through `lettre`; the engine is not involved. Reading files follows `engine-glue.md` rule 41 and `libraries.md` rules 30-36.

## SMTP settings

Plain `app_settings` keys written through `PUT /api/settings` (`settings.md`), admin only (`manage:settings`).

1. Keys: `smtp_host`, `smtp_port` (default by security: starttls 587, tls 465, none 25), `smtp_security` (`starttls` default, `tls` implicit TLS, `none`), `smtp_username`, `smtp_password` (secret: `settings.md` rule 16, listed in `secretsSet`, never returned), `smtp_from` (an address, optionally with a name), `smtp_max_attachment_mb` (1 to 200, default 50, Amazon's own limit).
2. Mail is enabled once `smtp_host` and a parsable `smtp_from` are set; until then `GET /api/email-devices` answers `enabled: false` and a send is `400 send_to_device.error_not_configured`.
3. A write that cannot hold is `400`: a port outside 1-65535, a security outside the three values, a sender or host that is not an address or contains a control character, a size outside 1-200. A blank value unsets the key.
4. TLS: `starttls` requires the upgrade (a server that does not offer it is an error, never a plain fallback), `tls` connects encrypted, and both verify the certificate against the bundled Mozilla roots. `none` is plain text and refuses a username: credentials never travel in clear. Connect and I/O time out after 30 s. A host the admin names is accepted as given (admin only, like notification endpoints).

## Devices

5. `email_devices("id", "userId" -> users ON DELETE CASCADE, name, kind, address, formats text[], "createdAt", "updatedAt")`, `UNIQUE("userId", name)`. `kind` is `kindle | kobo | pocketbook | other`. `formats` is a non-empty set of distinct values among `epub pdf mobi azw3 fb2 cbz`: what the device accepts. Absent on creation it defaults to `epub, pdf` (`kobo`: `epub`).
6. A user holds at most 10 devices (`400 email_devices.error_too_many`, serialised on the user row). A name is unique per user (`409 email_devices.error_name_taken`, also under a race).
7. `address` is one bare address (`Name <a@b>`, a space or a control character is `400`), at most 254 characters, stored as parsed. Every row is the caller's own: another user's id is `404 email_devices.error_unknown`. Session credentials only: a scoped token is `403 session_token_required`.

| Method path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/email-devices` | none | `{ enabled, maxBytes \| null, devices: EmailDevice[] }`, oldest first | 401, 403 |
| `POST /api/email-devices` | `{ name (1..80), kind, address, formats? }` | 201 `EmailDevice` | 400, 409 |
| `PUT /api/email-devices/:id` | same, whole replacement | 200 `EmailDevice` | 400, 404, 409 |
| `DELETE /api/email-devices/:id` | none | 204 | 404 |
| `POST /api/email-devices/:id/send` | `{ fileId }` | 202 `BookSend` | 400, 404, 413, 429 |
| `GET /api/book-sends` | none | the caller's 20 latest `BookSend`, newest first | 401, 403 |
| `POST /api/email/test` | `{ to }` (admin) | 200 `{ ok, message }` | 400, 403 |

`EmailDevice { id, name, kind, address, formats, createdAt }`. `BookSend { id, deviceName, fileName, bytes, status, error \| null, createdAt, updatedAt }`.

## Send

8. The file is read as a download is: `resolve_file` with the caller, so a file outside the caller's libraries, or linked by an edition they cannot read, is `404 MediaFile #<id> not found`.
9. The extension must be one of the device's `formats`, else `400 send_to_device.error_format`. A file larger than `smtp_max_attachment_mb` is `413 send_to_device.error_too_big`, before anything is queued; the attachment is the file as stored (an EPUB is sent unchanged, nothing is converted).
10. Limits per user, checked under the user row lock: 20 sends per hour and 3 unfinished ones, else `429 send_to_device.error_rate_limited`. At most 2 mails are built at once in the process.
11. `book_sends("id", "userId" -> users CASCADE, "deviceId" -> email_devices SET NULL, "deviceName", "fileId" -> media_files SET NULL, "fileName", bytes, status, error, "createdAt", "updatedAt")` is the audit and the status of the asynchronous job. `status` is `queued | sending | sent | failed`. The device address is not copied. Each queued send is logged (`user`, `device`, `file`, `send`).
12. The job rereads the settings, reads at most the limit plus one byte of the file and mails it. `error` is a code, never a server answer or host: `rejected` (the SMTP server refused or deferred), `connection` (no connection, TLS or timeout), `not_configured`, `file_unreadable`, `too_big`, `internal`. The detail is logged. A boot turns every `queued` or `sending` row into `failed` with `interrupted` (the mail may have left).
13. `POST /api/email/test` mails a fixed message to `to`; unlike a user's send, a failure answers `{ ok: false, message }` with the server's own error text (control characters removed, 300 characters at most). `200` both ways.
14. Headers: the mail has one `From` (`smtp_from`) and one `To` (the device address, parsed). The subject and the attachment name come from the file name: path, quote and backslash removed, control characters turned into spaces, 150 characters at most, so a name can never open a header line.
15. No notification event is emitted: the notification vocabulary is fixed (`notifications.md` rule 2) and a send is answered to its own user through `GET /api/book-sends`.
