// Wire contract: plans/comics-contract.md

// GET /api/media?type=comic list items carry `comic`
export interface ComicListInfo {
  publisher: string | null;
  startYear: number | null;
  issueCount: number;
  readCount: number;
}

export interface ComicIssue {
  itemId: number;
  /** Null: the issue is known but has no file. */
  mediaFileId: number | null;
  /** Archive format of the file; a PDF opens the PDF reader. */
  format: 'cbz' | 'cb7' | 'cbr' | 'pdf' | null;
  number: string;
  sort: number;
  /** Where the issue is listed: `annual` is true for anything but a plain issue. */
  kind: 'issue' | 'annual' | 'special';
  annual: boolean;
  title: string | null;
  overview: string | null;
  releaseDate: string | null;
  pageCount: number | null;
  /** The caller's 0..1; null when never opened. */
  progression: number | null;
  finished: boolean;
}

// GET /api/media/:id of a comic carries `comic`
export interface ComicDetail {
  publisher: string | null;
  startYear: number | null;
  volume: number | null;
  /** Main issues by sort, then annuals by sort. */
  issues: ComicIssue[];
}

// GET /api/comics/:itemId/pages
export interface ComicPageSize {
  width: number;
  height: number;
}

// PATCH /api/media/:id/comic: each key present is set and locked
export interface ComicVolumePatch {
  title?: string;
  overview?: string | null;
  publisher?: string | null;
  startYear?: number | null;
  volume?: number | null;
  /** Removes the lock of these fields: a scan fills them again. */
  unlock?: ('title' | 'overview' | 'publisher' | 'startYear' | 'volume')[];
}

// PATCH /api/comics/issues/:itemId
export interface ComicIssuePatch {
  number?: string;
  sort?: number;
  kind?: ComicIssue['kind'];
  title?: string | null;
  overview?: string | null;
  releaseDate?: string | null;
  unlock?: ('number' | 'sort' | 'kind' | 'title' | 'overview' | 'releaseDate')[];
}
