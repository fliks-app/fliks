import { Matches } from 'class-validator';

export class ConfirmImportDto {
  /** `sha256(zip).slice(0, 32)` — the id `inspect` returned. */
  @Matches(/^[0-9a-f]{32}$/)
  stagingId: string;

  /** The full `sha256` the client saw in the `inspect` response. */
  @Matches(/^[0-9a-f]{64}$/)
  sha256: string;
}
