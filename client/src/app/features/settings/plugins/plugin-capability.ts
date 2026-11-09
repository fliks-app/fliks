import { TranslateService } from '@ngx-translate/core';

const KEYED = new Set(['ui', 'config', 'scope', 'ingestroot', 'job', 'webhook', 'namespace', 'provider', 'network']);

/** One label per capability the backend's `capabilities` derives; `provider:<ns>:<kind>` shows its kind. */
export function capabilityLabel(translate: TranslateService, capability: string): string {
  const separator = capability.indexOf(':');
  const prefix = separator === -1 ? capability : capability.slice(0, separator);
  const rest = separator === -1 ? '' : capability.slice(separator + 1);
  const value = prefix === 'provider' ? rest.slice(rest.lastIndexOf(':') + 1) : rest;
  return KEYED.has(prefix) ? translate.instant(`settings.plugins.consent.capability.${prefix}`, { value }) : capability;
}

/** The manifest lists a capability once per contribution: show each permission once. */
export function capabilityLabels(translate: TranslateService, capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map((c) => capabilityLabel(translate, c)))];
}
