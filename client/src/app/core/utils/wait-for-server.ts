import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** Polls the health route until the server answers again, for up to two minutes. */
export async function waitForServer(http: HttpClient): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      await firstValueFrom(http.get('/api/system/health'));
      return;
    } catch {
      // Still down: keep polling.
    }
  }
}
