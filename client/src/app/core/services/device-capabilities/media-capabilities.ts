/** `navigator.mediaCapabilities`, the second opinion behind `canPlayType` and `isTypeSupported`; undefined where the API is missing. */
function capabilities(): MediaCapabilities | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.mediaCapabilities;
}

const PROBE_SIZE = { width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 };

/** The video MIMEs `decodingInfo` refuses; a MIME it throws on keeps the verdict of the engine's own probe. */
export async function undecodableVideoMimes(mimes: readonly string[]): Promise<Set<string>> {
  const caps = capabilities();
  const denied = new Set<string>();
  if (!caps?.decodingInfo) return denied;
  await Promise.all(
    mimes.map(async (contentType) => {
      try {
        const r = await caps.decodingInfo({ type: 'media-source', video: { contentType, ...PROBE_SIZE } });
        if (!r.supported) denied.add(contentType);
      } catch {
        // Unknown type to the engine: the probe's own answer stands.
      }
    }),
  );
  return denied;
}

export interface HdrTransfers {
  pq: boolean;
  hlg: boolean;
}

/** 10-bit codec strings an HDR stream may use, widest support first. */
const HDR_CODECS = ['hvc1.2.4.L153.B0', 'vp09.02.10.10', 'av01.0.08M.10'];

/** Whether the engine decodes and presents PQ and HLG, from `decodingInfo`; null where the API or its transfer-function members are missing, so the display query alone decides. */
export async function detectHdrTransfers(): Promise<HdrTransfers | null> {
  const caps = capabilities();
  if (!caps?.decodingInfo) return null;
  let answered = false;
  const decodes = async (transferFunction: 'pq' | 'hlg') => {
    for (const codec of HDR_CODECS) {
      try {
        const r = await caps.decodingInfo({
          type: 'media-source',
          video: {
            contentType: `video/${codec.startsWith('vp09') ? 'webm' : 'mp4'}; codecs="${codec}"`,
            width: 3840,
            height: 2160,
            bitrate: 20_000_000,
            framerate: 24,
            colorGamut: 'rec2020',
            transferFunction,
            hdrMetadataType: transferFunction === 'pq' ? 'smpteSt2086' : undefined,
          } as VideoConfiguration,
        });
        answered = true;
        if (r.supported) return true;
      } catch {
        // The member is unknown to this engine: no answer from this probe.
      }
    }
    return false;
  };
  const [pq, hlg] = [await decodes('pq'), await decodes('hlg')];
  return answered ? { pq, hlg } : null;
}
