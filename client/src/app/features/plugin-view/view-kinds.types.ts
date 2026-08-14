import type { ConfigPage, FormConfigPage, ProvidersConfigPage, TableConfigPage } from '@fliks/plugin-contract/ui';

/** The contract discriminates `ConfigPage` on `kind`; these narrow it for the renderer switch. */
export type AnyConfigPage = ConfigPage;
export type ProvidersView = ProvidersConfigPage;
export type TableView = TableConfigPage;

export function isProvidersView(page: AnyConfigPage): page is ProvidersConfigPage {
  return page.kind === 'providers';
}

export function isTableView(page: AnyConfigPage): page is TableConfigPage {
  return page.kind === 'table';
}

/** Omitting `kind` means `form`, so an older manifest keeps working. */
export function isFormView(page: AnyConfigPage): page is FormConfigPage {
  return page.kind === undefined || page.kind === 'form';
}
