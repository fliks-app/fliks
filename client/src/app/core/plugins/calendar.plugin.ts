import { Capacitor, registerPlugin } from '@capacitor/core';
import { desktopBridgeOrNull } from './desktop-player.bridge';
import { saveFile } from './save-file.plugin';

interface CalendarPlugin {
  /** Opens the system calendar UI on a prefilled event; times are epoch ms. */
  addEvent(o: { title: string; start: number; end: number; url: string; notes?: string }): Promise<{ added: boolean }>;
}
const Calendar = registerPlugin<CalendarPlugin>('Calendar');

export interface CalendarEvent {
  id: number;
  title: string;
  start: Date;
  end: Date;
  url: string;
  /** The same event as an ICS, for the desktop handler and the web download. */
  ics: string;
}

/** Adds an event to the OS calendar: the native sheet on mobile, the default ICS handler on desktop, a download on web. */
export async function addToCalendar(e: CalendarEvent): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Calendar.addEvent({ title: e.title, start: e.start.getTime(), end: e.end.getTime(), url: e.url });
    return;
  }
  const desktop = desktopBridgeOrNull();
  if (desktop?.openCalendarEvent) return desktop.openCalendarEvent(e.ics, `party-${e.id}.ics`);
  await saveFile(new Blob([e.ics], { type: 'text/calendar;charset=utf-8' }), `party-${e.id}.ics`);
}
