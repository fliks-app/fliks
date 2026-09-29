import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

@Injectable({ providedIn: 'root' })
export class NetworkService {
  readonly isOnline = signal(navigator.onLine);
  /** Bumped when an API call dies without an answer or the OS reports a
   *  network change: a VPN with no underlying link keeps `isOnline` true. */
  readonly connectivityDoubt = signal(0);

  reportDoubt(): void {
    this.connectivityDoubt.update((n) => n + 1);
  }

  constructor() {
    window.addEventListener('online', () => this.isOnline.set(true));
    window.addEventListener('offline', () => this.isOnline.set(false));

    // WKWebView keeps `navigator.onLine` at true on a device with no route and
    // never fires the DOM events for it, so on native the OS reachability API
    // is the only source that actually reports offline. Imported lazily to keep
    // the plugin out of the web bundle.
    if (Capacitor.isNativePlatform()) {
      void import('@capacitor/network')
        .then(({ Network }) => {
          void Network.getStatus().then((s) => this.isOnline.set(s.connected));
          void Network.addListener('networkStatusChange', (s) => {
            this.isOnline.set(s.connected);
            this.reportDoubt();
          });
        })
        .catch(() => {
          /* plugin missing on this build — DOM events stay the only source */
        });
    }
  }
}
