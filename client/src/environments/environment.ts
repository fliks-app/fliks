import { CAST_APP_ID } from './cast-app-id';

export const environment = {
  production: false,
  /** Client build version, kept in sync with client/package.json by release-please; reported by non-web clients to the admin streams dashboard. */
  version: '5.2.1', // x-release-please-version
  /** Cast receiver app ID from the Cast Developer Console; `CC1AD845` is Google's Default Media Receiver, an unbranded fallback needing no registration. */
  castAppId: CAST_APP_ID,
};
