import { app } from 'electron';

/** The `X-Fliks-Client` header the main process sends on its own requests to the server. */
export const fliksClientHeader = (): Record<string, string> => ({ 'X-Fliks-Client': `desktop/${app.getVersion()}` });
