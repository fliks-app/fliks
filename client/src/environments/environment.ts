export const environment = {
  production: false,
  /** Fliks client build version, kept in sync with client/package.json by
   *  release-please. Reported to the backend (non-web clients only) so the
   *  admin streams dashboard can show which app build a viewer is running. */
  version: '3.2.0', // x-release-please-version
  /** Base URL pour ApiHandlerService (chemins versionnés sous /api). */
  apiUrl: '/api',
  /**
   * Google Cast receiver app ID. Replace with the ID generated in the
   * Cast Developer Console (https://cast.google.com/publish/) after
   * registering the receiver shell URL hosted from `cast-receiver/`
   * (typically `https://<owner>.github.io/<repo>/`).
   *
   * `CC1AD845` is Google's Default Media Receiver — works out of the
   * box with no console registration but no Fliks branding. Keep as
   * fallback so devs without console access can still cast.
   */
  castAppId: '66BF4DAE',
};
