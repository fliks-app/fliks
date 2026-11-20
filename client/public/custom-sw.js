// Angular's service worker handles caching; push, clicks and actions are ours.
importScripts('./ngsw-worker.js');

const ICON = '/icons/icon-192x192.png';

// The worker has no translate service: the two outcome lines of a `call` action, per UI language.
const OUTCOME = {
  en: ['Done.', 'The action failed.'],
  fr: ['Fait.', "L'action a échoué."],
  de: ['Erledigt.', 'Die Aktion ist fehlgeschlagen.'],
  es: ['Hecho.', 'La acción falló.'],
  it: ['Fatto.', "L'azione non è riuscita."],
  pt: ['Feito.', 'A ação falhou.'],
};

// The plaintext version this worker reads; a higher one gets the generic text (the same as the native apps').
const PLAIN_VERSION = 1;
const UNREADABLE = {
  en: ['New notification', 'Update Fliks to read it.'],
  fr: ['Nouvelle notification', 'Mettez à jour Fliks pour la lire.'],
  de: ['Neue Benachrichtigung', 'Aktualisieren Sie Fliks, um sie zu lesen.'],
  es: ['Nueva notificación', 'Actualice Fliks para leerla.'],
  it: ['Nuova notifica', 'Aggiorna Fliks per leggerla.'],
  pt: ['Nova notificação', 'Atualize o Fliks para a ler.'],
};

self.addEventListener('push', (event) => {
  let n;
  try {
    n = event.data?.json();
  } catch {
    n = null;
  }
  if (n?.v > PLAIN_VERSION) {
    event.waitUntil(unreadable());
    return;
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
        data: { url: n.url, user: n.user, tag: n.tag ?? n.id, actions },
        actions: actions.map((a) => ({ action: a.id, title: a.title })),
      }),
      setBadge(n.badge),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  const { url, user, tag, actions } = event.notification.data ?? {};
  event.notification.close();
  const action = (actions ?? []).find((a) => a.id === event.action);
  event.waitUntil(action?.kind === 'call' ? call(action, url, user, tag) : open(action?.url ?? url, user));
});

// The refresh token lives in the page's storage, not in the worker: an expired access cookie (401) opens the app at the notification's url instead.
async function call(action, url, user, tag) {
  let status = 0;
  try {
    const r = await fetch('/api/push/act', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: action.token }),
    });
    status = r.status;
  } catch {
    // offline: reported as a failure below
  }
  if (status === 401) return open(url, user);
  const [done, failed] = await localized(OUTCOME);
  return self.registration.showNotification(status >= 200 && status < 300 ? action.done || done : failed, { icon: ICON, badge: ICON, tag, data: { url, user } });
}

async function unreadable() {
  const [title, body] = await localized(UNREADABLE);
  return self.registration.showNotification(title, { body, icon: ICON, badge: ICON, tag: 'unreadable', data: { url: '/' } });
}

async function localized(texts) {
  const lang = (await savedLang()) ?? navigator.language ?? 'en';
  return texts[lang.slice(0, 2)] ?? texts.en;
}

// The page tells the worker its UI language (it can differ from the browser's); the Cache API survives worker restarts.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'fliks-push-lang') {
    event.waitUntil(caches.open('fliks-push').then((c) => c.put('/lang', new Response(String(event.data.lang)))));
  }
});

async function savedLang() {
  try {
    return await (await (await caches.open('fliks-push')).match('/lang'))?.text();
  } catch {
    return undefined;
  }
}

function setBadge(count) {
  if (count === undefined) return Promise.resolve();
  return (count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.())?.catch(() => undefined);
}

// Only a path of this origin: `//host` and `/\host` resolve to another origin.
function sameOriginPath(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

async function open(url, user) {
  const target = sameOriginPath(url) ?? '/';
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => 'focus' in c);
  if (client) {
    await client.focus();
    client.postMessage({ type: 'fliks-push-open', url: target, user });
  } else {
    await self.clients.openWindow(target);
  }
}
