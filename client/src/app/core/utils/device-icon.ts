export type DeviceIcon = 'tv' | 'tablet' | 'phone' | 'monitor' | 'cast' | 'airplay';

/** The icon of a device from its reported form factor; anything unknown reads as a computer. */
export function deviceIconFor(formFactor: string | null | undefined): DeviceIcon {
  switch (formFactor) {
    case 'tv': return 'tv';
    case 'tablet': return 'tablet';
    case 'phone': return 'phone';
    default: return 'monitor';
  }
}
