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
  number: string;
  sort: number;
  annual: boolean;
  title: string | null;
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
