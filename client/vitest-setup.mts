import { vi } from 'vitest';

// isolate:false keeps evaluated modules between files, so a spec's vi.mock would leak into the next ones.
vi.resetModules();
