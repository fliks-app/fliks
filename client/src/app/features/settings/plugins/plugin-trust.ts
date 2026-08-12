import type { PluginTrust } from '../../../core/services/api/plugins-api.service';

export interface TrustBadge {
  labelKey: string;
  params?: Record<string, string>;
  cssClass: string;
}

/** Maps backend `TrustOutcome` onto the four-badge model (Official / Verified / Unverified / Imported manually). */
export function trustBadgeFor(trust: PluginTrust | undefined): TrustBadge {
  if (trust === 'official') return { labelKey: 'settings.plugins.trust.official', cssClass: 'badge-success' };
  if (trust === 'unsigned') return { labelKey: 'settings.plugins.trust.manual', cssClass: 'badge-ghost' };
  if (trust === 'unverified' || !trust) return { labelKey: 'settings.plugins.trust.unverified', cssClass: 'badge-warning' };
  return {
    labelKey: 'settings.plugins.trust.verified',
    params: { key: trust.slice('verified-'.length) },
    cssClass: 'badge-success',
  };
}

/** Gate for the consent sheet's acknowledgement checkbox: anything without an attributable signature. */
export function requiresAcknowledgement(trust: PluginTrust | undefined): boolean {
  return trust === 'unverified' || trust === 'unsigned' || !trust;
}
