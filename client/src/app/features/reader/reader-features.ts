export type ReaderFormat = 'epub' | 'pdf' | 'comic';

/** Sections of the appearance panel: the page theme, the text layout of a reflowable book, the layout of a comic. */
export type AppearanceSection = 'theme' | 'text' | 'comic';

/** What the reader offers for one format; the bars and panels show only what is on. */
export interface ReaderFeatures {
  contents: boolean;
  search: boolean;
  bookmarks: boolean;
  notes: boolean;
  appearance: readonly AppearanceSection[];
  zoom: boolean;
  /** Offered when the book also has an audio edition. */
  listen: boolean;
  /** The faint title and page lines shown while the bars are away. */
  runningHead: boolean;
}

const NONE: ReaderFeatures = {
  contents: false,
  search: false,
  bookmarks: false,
  notes: false,
  appearance: [],
  zoom: false,
  listen: false,
  runningHead: false,
};

/** The one place a feature is turned on or off per format; each engine implements the capabilities it is given here. */
export const READER_FEATURES: Record<ReaderFormat, ReaderFeatures> = {
  epub: {
    ...NONE,
    contents: true,
    search: true,
    bookmarks: true,
    notes: true,
    appearance: ['theme', 'text'],
    listen: true,
    runningHead: true,
  },
  pdf: { ...NONE, appearance: ['theme'], zoom: true, listen: true },
  comic: { ...NONE, appearance: ['comic'], zoom: true },
};
