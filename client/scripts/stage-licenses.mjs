// Copies the notices into `browser/`: every bundle (image, desktop, Capacitor) ships that folder, not its parent.
import { copyFileSync } from 'node:fs';

const dist = process.argv[2] ?? 'dist/client';
copyFileSync(`${dist}/3rdpartylicenses.txt`, `${dist}/browser/3rdpartylicenses.txt`);
copyFileSync('../THIRD-PARTY-NOTICES.md', `${dist}/browser/THIRD-PARTY-NOTICES.md`);
