import { dialog } from 'electron';
import type { TrustPrompt } from './trusted-servers';

/** PEM entries of `cert` and the issuers Chromium resolved above it, leaf first. */
export function pemChain(cert: Electron.Certificate): string[] {
  const chain: string[] = [];
  for (let c: Electron.Certificate | undefined = cert; c && chain.length < 8 && !chain.includes(c.data); c = c.issuerCert) {
    chain.push(c.data);
  }
  return chain;
}

/** Asks whether to trust the certificate a self-hosted server presented; refusal is the default. */
export async function askTrust({ origin, cert, changed, mpvUnverified }: TrustPrompt): Promise<boolean> {
  const detail = [
    changed
      ? 'The certificate of this server is not the one you trusted before. This can be an attack on your network: trust it only if you replaced the certificate yourself.'
      : 'The operating system does not trust this certificate. Trust it only if this is your own server.',
    mpvUnverified ? 'The video player cannot check it (its name does not match the address, or it has expired), so streams from this server are not verified.' : '',
    `Fingerprint: ${cert.fingerprint}`,
  ];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Fliks',
    message: `Trust the certificate of ${origin}?`,
    detail: detail.filter(Boolean).join('\n\n'),
    buttons: ['Refuse', 'Trust'],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}
