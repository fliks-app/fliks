import type { WebContents } from 'electron';

const MAX_RELOADS = 3;
const WINDOW_MS = 60_000;

/** Allows a few reloads per minute, so a page that crashes on load can't spin. */
export class ReloadBudget {
  private readonly at: number[] = [];
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  take(): boolean {
    const t = this.now();
    while (this.at.length && t - this.at[0]! > WINDOW_MS) this.at.shift();
    if (this.at.length >= MAX_RELOADS) return false;
    this.at.push(t);
    return true;
  }
}

/** Static page shown once reloading keeps failing; the button goes back to the app. */
export function crashPageUrl(appUrl: string): string {
  const html =
    '<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:16px;background:#1d232a;color:#fff;font:16px sans-serif">' +
    '<div>Fliks stopped responding.</div>' +
    `<button style="font:inherit;padding:8px 20px" onclick="location.href=${JSON.stringify(appUrl)}">Reload</button></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** On a renderer crash: stop playback (the video would play on under a dead UI), then reload the app, or show the crash page when reloads keep failing. */
export function watchRendererCrash(
  wc: WebContents,
  opts: {
    appUrl: string;
    stopPlayback: () => Promise<void> | void;
    log: (line: string) => void;
    budget?: ReloadBudget;
  },
): void {
  const budget = opts.budget ?? new ReloadBudget();
  wc.on('render-process-gone', async (_e, details) => {
    opts.log(`[renderer] gone ${JSON.stringify(details)}`);
    if (details.reason === 'clean-exit') return;
    try {
      await opts.stopPlayback();
    } catch (e) {
      opts.log(`[renderer] stop after crash failed: ${e}`);
    }
    if (wc.isDestroyed()) return;
    await wc.loadURL(budget.take() ? opts.appUrl : crashPageUrl(opts.appUrl)).catch(() => {});
  });
}
