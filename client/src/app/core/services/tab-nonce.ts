/** Time a nonce's holder gets to answer, or to release it when its page is reloading. */
const WAIT_MS = 750;
const CHANNEL = 'fliks.tab';

/** Holds `nonce` for the page's life. False when another live tab holds it (a duplicated tab copies `sessionStorage`). */
export function holdTabNonce(nonce: string): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? holdByLock(locks, nonce) : holdByChannel(nonce);
}

/** Queues for the lock, so a reload whose old page has not released it yet still gets its own nonce back. */
function holdByLock(locks: LockManager, nonce: string): Promise<boolean> {
  return new Promise((resolve) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WAIT_MS);
    locks
      .request(`fliks.tab.${nonce}`, { signal: abort.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        return new Promise<never>(() => {});
      })
      .catch((e: unknown) => resolve(!(e instanceof DOMException && e.name === 'AbortError')));
  });
}

/** Web Locks only exist in secure contexts: elsewhere (http over the LAN) the holder of a nonce answers a broadcast.
 * Tabs asking at once settle on the lowest random id, so two simultaneous restores end with distinct nonces. */
function holdByChannel(nonce: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(CHANNEL);
    const id = Math.random();
    let claimed = false;
    const lose = () => {
      clearTimeout(timer);
      channel.close();
      resolve(false);
    };
    const timer = setTimeout(() => {
      channel.onmessage = (e) => {
        if (e.data?.ask === nonce) channel.postMessage({ held: nonce });
      };
      resolve(true);
    }, WAIT_MS / 3);
    channel.onmessage = (e) => {
      if (e.data?.held === nonce) return lose();
      if (e.data?.ask !== nonce) return;
      if (e.data.id < id) return lose();
      if (!claimed) {
        claimed = true;
        channel.postMessage({ ask: nonce, id });
      }
    };
    channel.postMessage({ ask: nonce, id });
  });
}
