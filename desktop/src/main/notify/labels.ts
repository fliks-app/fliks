import { app } from 'electron';

type Labels = { open: string; quit: string; notifications: string };

const LABELS: Record<string, Labels> = {
  en: { open: 'Open Fliks', quit: 'Quit Fliks', notifications: 'Notifications' },
  fr: { open: 'Ouvrir Fliks', quit: 'Quitter Fliks', notifications: 'Notifications' },
  es: { open: 'Abrir Fliks', quit: 'Salir de Fliks', notifications: 'Notificaciones' },
  de: { open: 'Fliks öffnen', quit: 'Fliks beenden', notifications: 'Benachrichtigungen' },
  it: { open: 'Apri Fliks', quit: 'Esci da Fliks', notifications: 'Notifiche' },
  pt: { open: 'Abrir o Fliks', quit: 'Sair do Fliks', notifications: 'Notificações' },
};

export function labels(): Labels {
  const lang = app.getLocale().slice(0, 2);
  return LABELS[lang] ?? LABELS['en'];
}
