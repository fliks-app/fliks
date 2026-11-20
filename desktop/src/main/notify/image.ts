const MAX_BYTES = 2_000_000;
const MAX_SIDE = 2048;

/** The body of `res`, or undefined once it exceeds `max` bytes (declared or streamed). */
export async function readCapped(res: Response, max = MAX_BYTES): Promise<Buffer | undefined> {
  if (!res.ok || !res.body || Number(res.headers.get('content-length') ?? 0) > max) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A decoded picture is kept only at a sane pixel size. */
export const saneSize = ({ width, height }: { width: number; height: number }): boolean =>
  width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE;
