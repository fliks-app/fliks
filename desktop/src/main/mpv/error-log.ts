const MAX_LINES = 12;

/** The error/fatal mpv log lines of the current playback attempt. mpv's `end-file` error carries only a
 *  generic string; the cause (TLS, HTTP status, codec) is in these lines, which ride on the error event. */
export class MpvErrorLog {
  private lines: string[] = [];
  private transport = false;

  /** Only error and fatal lines count. A transport failure is mpv's own signature: prefix exactly
   *  `curl`/`tls` or a "Failed to open" message; anything looser would label a decode failure as network. */
  record(level: string, prefix: string | undefined, text: string | undefined): void {
    if (level !== 'error' && level !== 'fatal') return;
    this.lines.push(`${prefix ? `${prefix}: ` : ''}${text ?? ''}`.trim());
    if (this.lines.length > MAX_LINES) this.lines.shift();
    if (prefix === 'curl' || prefix === 'tls' || (text ?? '').includes('Failed to open')) this.transport = true;
  }

  /** A frame plays again: what was buffered was resolved or belongs to the segment that succeeded. */
  reset(): void {
    this.lines = [];
    this.transport = false;
  }

  get any(): boolean {
    return this.lines.length > 0;
  }

  /** `code` follows MediaError semantics: 2 (network) on a transport signature, else -1. */
  payload(message: string): { code: number; message: string; detail?: string } {
    return { code: this.transport ? 2 : -1, message, detail: this.lines.join(' | ') || undefined };
  }
}
