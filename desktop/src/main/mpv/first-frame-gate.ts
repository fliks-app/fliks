/** Cap on a load()'s first-frame wait: a file that never opens (dead stream, bad
 *  URL) must not hang the caller. */
export const FIRST_FRAME_TIMEOUT_MS = 15_000;

/** Holds a libmpv backend's load() open until the new file has opened. The
 *  addons only queue `loadfile`, so resolving earlier lets a caller's follow-up
 *  `sub-add` run while no file is open, and mpv rejects it. */
export class FirstFrameGate {
  private current: (() => void) | null = null;

  /** Releases any superseded wait, then waits for {@link release} or the timeout. */
  wait(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    this.release();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.current === done) this.current = null;
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.current = done;
    });
  }

  /** Called on first frame, error, stop and teardown so no load() is left hanging. */
  release(): void {
    this.current?.();
  }
}
