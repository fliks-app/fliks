import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
  computed,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, CalendarEntry } from '../../core/services/api/media.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';

interface CalendarWeek {
  days: CalendarDay[];
}

interface CalendarDay {
  date: Date;
  dateStr: string;
  isToday: boolean;
  isCurrentMonth: boolean;
  entries: CalendarEntry[];
}

@Component({
  selector: 'app-calendar',
  imports: [RouterLink, TranslateModule, NgClass, LocaleDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calendar.html',
})
export class CalendarComponent implements OnInit {
  private readonly mediaService = inject(MediaService);

  readonly currentDate = signal(new Date());
  readonly entries = signal<CalendarEntry[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly showCinema = signal(this.loadFilter('cinema'));
  readonly showDigital = signal(this.loadFilter('digital'));
  readonly showPhysical = signal(this.loadFilter('physical'));
  readonly showAiring = signal(this.loadFilter('airing'));
  readonly filteredEntries = computed(() => {
    let result = this.entries();
    if (!this.showCinema()) result = result.filter((e) => e.event !== 'cinema');
    if (!this.showDigital()) result = result.filter((e) => e.event !== 'digital');
    if (!this.showPhysical()) result = result.filter((e) => e.event !== 'physical');
    if (!this.showAiring()) result = result.filter((e) => e.event !== 'airing');
    return result;
  });

  readonly weeks = computed<CalendarWeek[]>(() => {
    const now = this.currentDate();
    const today = new Date();
    const todayStr = this.toDateStr(today);
    const year = now.getFullYear();
    const month = now.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Start on Monday
    const startOffset = (firstDay.getDay() + 6) % 7;
    const start = new Date(firstDay);
    start.setDate(start.getDate() - startOffset);

    const entriesByDate = new Map<string, CalendarEntry[]>();
    for (const entry of this.filteredEntries()) {
      const key = entry.date.substring(0, 10);
      if (!entriesByDate.has(key)) entriesByDate.set(key, []);
      entriesByDate.get(key)!.push(entry);
    }

    const weeks: CalendarWeek[] = [];
    let current = new Date(start);

    while (current <= lastDay || weeks.length < 5) {
      const week: CalendarDay[] = [];
      for (let d = 0; d < 7; d++) {
        const dateStr = this.toDateStr(current);
        week.push({
          date: new Date(current),
          dateStr,
          isToday: dateStr === todayStr,
          isCurrentMonth: current.getMonth() === month,
          entries: entriesByDate.get(dateStr) ?? [],
        });
        current = new Date(current);
        current.setDate(current.getDate() + 1);
      }
      weeks.push({ days: week });
      if (current > lastDay && weeks.length >= 4) break;
    }

    return weeks;
  });

  ngOnInit() {
    this.loadMonth();
  }

  prevMonth() {
    this.currentDate.update((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
    this.loadMonth();
  }

  nextMonth() {
    this.currentDate.update((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
    this.loadMonth();
  }

  private async loadMonth() {
    const d = this.currentDate();
    const start = new Date(d.getFullYear(), d.getMonth(), 1 - 7);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 7);
    const startStr = this.toDateStr(start);
    const endStr = this.toDateStr(end);
    this.loading.set(true);
    this.error.set('');
    try {
      const data = await this.mediaService.getCalendar(startStr, endStr);
      this.entries.set(data);
    } catch {
      this.error.set('calendar.load_error');
    } finally {
      this.loading.set(false);
    }
    queueMicrotask(() => {
      void this.mediaService
        .getCalendar(startStr, endStr, false, false, { force: true })
        .then((fresh) => this.entries.set(fresh))
        .catch(() => { /* keep cached entries */ });
    });
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  routeForEntry(e: CalendarEntry): string[] {
    return ['/', e.type === 'movie' ? 'movies' : 'series', String(e.mediaId)];
  }

  entryLabel(e: CalendarEntry): string {
    if (e.type === 'movie') return e.title;
    const ep = `S${String(e.seasonNumber ?? 0).padStart(2, '0')}E${String(e.episodeNumber ?? 0).padStart(2, '0')}`;
    const epTitle = e.episodeTitle ? ` — ${e.episodeTitle}` : '';
    return `${e.title} ${ep}${epTitle}`;
  }

  toggleFilter(event: string) {
    const signalMap: Record<string, ReturnType<typeof signal<boolean>>> = {
      cinema: this.showCinema,
      digital: this.showDigital,
      physical: this.showPhysical,
      airing: this.showAiring,
    };
    const s = signalMap[event];
    if (s) {
      s.update((v) => !v);
      this.saveFilter(event, s());
    }
  }

  isFilterActive(event: string): boolean {
    switch (event) {
      case 'cinema': return this.showCinema();
      case 'digital': return this.showDigital();
      case 'physical': return this.showPhysical();
      case 'airing': return this.showAiring();
      default: return true;
    }
  }

  private loadFilter(event: string): boolean {
    const val = localStorage.getItem(`calendar_filter_${event}`);
    return val === null ? true : val === '1';
  }

  private saveFilter(event: string, active: boolean) {
    localStorage.setItem(`calendar_filter_${event}`, active ? '1' : '0');
  }

  eventClass(e: CalendarEntry): string {
    switch (e.event) {
      case 'cinema': return 'bg-primary/15 text-primary';
      case 'digital': return 'bg-info/15 text-info';
      case 'physical': return 'bg-warning/15 text-warning';
      case 'airing': return 'bg-secondary/15 text-secondary';
      default: return 'bg-primary/15 text-primary';
    }
  }
}
