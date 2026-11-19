// Angular's service worker handles caching; push, clicks and actions are ours.
importScripts('./ngsw-worker.js');

const ICON = '/icons/icon-192x192.png';

self.addEventListener('push', (event) => {
  let n;
  try {
    n = event.data?.json();
  } catch {
    n = null;
  }
  if (!n?.title) return;
  const actions = (n.actions ?? []).slice(0, 2);
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(n.title, {
        body: n.body,
        icon: ICON,
        badge: ICON,
        image: n.image,
        tag: n.tag ?? n.id,
        renotify: !!n.tag,
        data: { url: n.url, actions },
        actions: actions.map((a) => ({ action: a.id, title: a.title })),
      }),
      setBadge(n.badge),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  const { url, actions } = event.notification.data ?? {};
  event.notification.close();
  const action = (actions ?? []).find((a) => a.id === event.action);
  if (action?.kind === 'call') {
    event.waitUntil(
      fetch('/api/push/act', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: action.token }),
      }).then((r) => (r.ok ? undefined : open(url)), () => open(url)),
    );
    return;
  }
  event.waitUntil(open(action?.url ?? url));
});

function setBadge(count) {
  if (count === undefined) return Promise.resolve();
  return (count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.())?.catch(() => undefined);
}

async function open(url) {
  const target = url?.startsWith('/') ? url : '/';
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => 'focus' in c);
  if (client) {
    await client.focus();
    client.postMessage({ type: 'fliks-push-open', url: target });
  } else {
    await self.clients.openWindow(target);
  }
}
