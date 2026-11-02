-- Parity seed delta "books" (docs/spec/books-api.md), applied on top of base.sql.
-- Library 3 is readable by `user`, `other` and `manager`; library 4 only by admin. Edition 102 of book 101 sits in
-- library 4, book 104 is in library 4. Ids start at 101 so base rows keep theirs.
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes") VALUES
 (3, '2026-01-01', '2026-01-01', 'Books', 'book', '#8b5cf6', '["book"]'),
 (4, '2026-01-01', '2026-01-01', 'Audiobooks', 'headphones', '#f59e0b', '["book"]');
INSERT INTO library_folders ("libraryId", path) VALUES
 (3, '/tmp/fliks-parity/media/books'), (4, '/tmp/fliks-parity/media/audiobooks');
INSERT INTO library_user_access ("libraryId", "userId") VALUES (3, 2), (3, 4), (3, 5);

INSERT INTO persons (id, "createdAt", "updatedAt", name, "sortName") VALUES
 (101, '2026-01-01', '2026-01-01', 'Una Writer', 'Writer, Una'),
 (102, '2026-01-01', '2026-01-01', 'Vic Voice', NULL),
 (103, '2026-01-01', '2026-01-01', 'Aaron Zed', NULL);

INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, overview, "folderName", "libraryId", "posterUrl") VALUES
 (101, '2026-01-01', '2026-01-01', 'Parity Book Alpha', 2001, 'book', 'Synthetic book alpha', 'Parity Book Alpha', 3, '/api/images/media/101/poster'),
 (102, '2026-01-01', '2026-01-01', 'Parity Book Beta', 2005, 'book', 'Synthetic book beta', 'Parity Book Beta', 3, NULL),
 (103, '2026-01-01', '2026-01-01', 'Parity Book Gamma', NULL, 'book', NULL, 'Parity Book Gamma', 3, NULL),
 (104, '2026-01-01', '2026-01-01', 'Parity Book Hidden', 2003, 'book', NULL, 'Parity Book Hidden', 4, NULL),
 (105, '2026-01-01', '2026-01-01', 'Parity Book Delta', 1999, 'book', NULL, 'Parity Book Delta', 3, NULL),
 (106, '2026-01-01', '2026-01-01', 'Parity Book Epsilon', 2010, 'book', NULL, 'Parity Book Epsilon', 3, NULL);
INSERT INTO book_details ("createdAt", "updatedAt", "mediaId", subtitle, "originalLanguage", subjects) VALUES
 ('2026-01-01', '2026-01-01', 101, 'A synthetic subtitle', 'en', '["Fiction", "Parity"]');
INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES (101, NULL, 'release', '2001-05-01');

INSERT INTO editions (id, "createdAt", "updatedAt", "mediaId", family, format, language, publisher, "libraryId", "pageCount", "durationSeconds", label) VALUES
 (101, '2026-01-01', '2026-01-01', 101, 'text', 'epub', 'fr', 'Parity Press', NULL, 300, NULL, 'Paper'),
 (102, '2026-01-01', '2026-01-01', 101, 'audio', 'm4b', 'en', NULL, 4, NULL, 3600, 'Hidden audio'),
 (103, '2026-01-01', '2026-01-01', 102, 'audio', 'm4b', 'fr', NULL, NULL, NULL, 150, NULL),
 (104, '2026-01-01', '2026-01-01', 103, 'audio', 'mp3', 'fr', NULL, NULL, NULL, NULL, NULL);
INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES (101, 101, 'release', '2002-02-02');
INSERT INTO items (id, "createdAt", "updatedAt", "mediaId", "editionId") VALUES
 (101, '2026-01-01', '2026-01-01', 101, 101), (102, '2026-01-01', '2026-01-01', 101, 102),
 (103, '2026-01-01', '2026-01-01', 102, 103), (104, '2026-01-01', '2026-01-01', 103, 104);
INSERT INTO media_files (id, "createdAt", "updatedAt", "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
 (101, '2026-01-01', '2026-01-01', 101, (SELECT f.id FROM library_folders f JOIN media m ON m."libraryId" = f."libraryId" WHERE m.id = 101), 'alpha.epub', 1, 'EPUB', '{}'),
 (102, '2026-01-01', '2026-01-01', 101, (SELECT f.id FROM library_folders f JOIN media m ON m."libraryId" = f."libraryId" WHERE m.id = 101), 'alpha.m4b', 1, 'M4B', '{}'),
 (103, '2026-01-01', '2026-01-01', 102, (SELECT f.id FROM library_folders f JOIN media m ON m."libraryId" = f."libraryId" WHERE m.id = 102), 'beta-1.m4b', 1, 'M4B', '{"durationSeconds": 100, "chapters": [{"title": "A", "startSeconds": 0, "endSeconds": 40}, {"title": "B", "startSeconds": 40, "endSeconds": 100}]}'),
 (104, '2026-01-01', '2026-01-01', 102, (SELECT f.id FROM library_folders f JOIN media m ON m."libraryId" = f."libraryId" WHERE m.id = 102), 'beta-2.m4b', 1, 'M4B', '{"durationSeconds": 50, "chapters": [{"title": "C", "startSeconds": 0, "endSeconds": 50}]}'),
 (105, '2026-01-01', '2026-01-01', 103, (SELECT f.id FROM library_folders f JOIN media m ON m."libraryId" = f."libraryId" WHERE m.id = 103), 'gamma.mp3', 1, 'MP3', '{"durationSeconds": 300}');
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
 (101, 101, 101, 0, 0), (102, 102, 101, 0, 0), (103, 103, 102, 0, 0), (103, 104, 102, 0, 1), (104, 105, 103, 0, 0);
UPDATE item_markers SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01' WHERE "itemId" >= 101;
INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value) VALUES
 (104, 103, 'asin', 'B000000001'), (101, 101, 'isbn', '9780000000002');
INSERT INTO edition_field_sources ("editionId", field, provider, locked, "updatedAt") VALUES (101, 'title', 'openlibrary', false, '2026-01-01');
INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", language, body, "fetchedAt") VALUES
 ('audnexus', 'chapters', 'book', 'B000000001', '', '{"chapters": [{"title": "Intro", "startMs": 0, "lengthMs": 60000}, {"title": "One", "startMs": 60000, "lengthMs": 120000}]}', '2026-01-01');

INSERT INTO media_credits (id, "createdAt", "updatedAt", "mediaId", "editionId", "personId", role, position) VALUES
 (101, '2026-01-01', '2026-01-01', 101, NULL, 101, 'author', 0), (102, '2026-01-01', '2026-01-01', 102, NULL, 101, 'author', 0),
 (103, '2026-01-01', '2026-01-01', 103, NULL, 101, 'author', 0), (104, '2026-01-01', '2026-01-01', 104, NULL, 101, 'author', 0),
 (105, '2026-01-01', '2026-01-01', 105, NULL, 103, 'author', 0), (106, '2026-01-01', '2026-01-01', 101, 102, 102, 'narrator', 0),
 (107, '2026-01-01', '2026-01-01', 102, 103, 102, 'narrator', 0), (108, '2026-01-01', '2026-01-01', 102, NULL, 103, 'translator', 0);

INSERT INTO collections (id, "createdAt", "updatedAt", name) VALUES
 (101, '2026-01-01', '2026-01-01', 'Parity Cycle'), (102, '2026-01-01', '2026-01-01', 'Parity Lonely');
INSERT INTO collection_external_ids ("collectionId", provider, value) VALUES (101, 'asin', 'B0ABCDEFGH');
INSERT INTO collection_entries ("collectionId", "mediaId", position, "positionLabel") VALUES
 (101, 101, 1, NULL), (101, 102, 2, 'II'), (101, 104, 3, NULL), (101, 103, 4, NULL), (102, 104, 1, NULL);

INSERT INTO playback_states ("createdAt", "updatedAt", "userId", "itemId", "positionSeconds", "durationSeconds", completed, "lastPlayedAt") VALUES
 ('2026-01-01', '2026-01-01', 2, 101, 30, 100, false, '2026-01-02'),
 ('2026-01-01', '2026-01-01', 2, 102, 10, 3600, false, '2026-01-05'),
 ('2026-01-01', '2026-01-01', 1, 103, 150, 150, true, '2026-01-03');

SELECT setval('media_files_id_seq', (SELECT max(id) FROM media_files));
SELECT setval('items_id_seq', (SELECT max(id) FROM items));
SELECT setval('editions_id_seq', (SELECT max(id) FROM editions));
SELECT setval('persons_id_seq', (SELECT max(id) FROM persons));
SELECT setval('media_credits_id_seq', (SELECT max(id) FROM media_credits));
SELECT setval('collections_id_seq', (SELECT max(id) FROM collections));
SELECT setval('libraries_id_seq', (SELECT max(id) FROM libraries));
SELECT setval('media_id_seq', (SELECT max(id) FROM media));
