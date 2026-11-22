import { Component, OnInit, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** The bundled notices read in the app: a `target="_blank"` link opens nowhere in the desktop and native shells. */
@Component({
  selector: 'app-licenses',
  imports: [TranslatePipe],
  templateUrl: './licenses.html',
})
export class LicensesPageComponent implements OnInit {
  protected readonly text = signal<string | null>(null);
  protected readonly failed = signal(false);

  async ngOnInit() {
    try {
      const res = await fetch(new URL('3rdpartylicenses.txt', document.baseURI));
      if (!res.ok) throw new Error(String(res.status));
      this.text.set(await res.text());
    } catch {
      this.failed.set(true);
    }
  }
}
