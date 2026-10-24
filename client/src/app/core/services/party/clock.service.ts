import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';

export interface ClockSample {
  offset: number;
  delay: number;
}

const KEEP = 8;
const BURST = 3;
const BURST_GAP_MS = 1000;
const STEADY_MS = 60_000;

/** NTP exchange: t0/t3 are local send/receive, t1/t2 the server's reception/reply. */
export function ntpSample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return { offset: (t1 - t0 + (t2 - t3)) / 2, delay: t3 - t0 - (t2 - t1) };
}

/** The sample with the smallest round trip: the least asymmetric one. */
export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  return samples.reduce<ClockSample | null>((b, s) => (!b || s.delay < b.delay ? s : b), null);
}

/** Server clock estimate, kept fresh only while a party needs it. */
@Injectable({ providedIn: 'root' })
export class ClockService {
  private readonly http = inject(HttpClient);
  private samples: ClockSample[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  readonly offsetMs = signal(0);
  readonly rttMs = signal(0);

  serverNow(): number {
    return Date.now() + this.offsetMs();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.samples = [];
    void this.tick(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(n: number): Promise<void> {
    if (!this.running) return;
    await this.ping();
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(n + 1), n + 1 < BURST ? BURST_GAP_MS : STEADY_MS);
  }

  private async ping(): Promise<void> {
    const t0 = Date.now();
    try {
      const { t1, t2 } = await firstValueFrom(
        this.http.get<{ t1: number; t2: number }>('/api/time', {
          context: new HttpContext().set(SKIP_ERROR_TOAST, true),
        }),
      );
      this.record(ntpSample(t0, t1, t2, Date.now()));
    } catch {
      /* the next tick retries */
    }
  }

  private record(sample: ClockSample): void {
    this.samples = [...this.samples, sample].slice(-KEEP);
    const best = bestSample(this.samples)!;
    this.offsetMs.set(best.offset);
    this.rttMs.set(Math.max(0, Math.round(best.delay)));
  }
}
