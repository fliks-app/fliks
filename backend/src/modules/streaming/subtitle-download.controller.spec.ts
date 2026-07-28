import { StreamingController } from './streaming.controller';

/** Captures what the route asks of the response. The header composition itself
 *  is Express's `attachment()`, which emits `filename` and `filename*` — not
 *  something this suite re-tests. */
function fakeRes() {
  return {
    attachment: jest.fn(),
    setHeader: jest.fn(),
    sendFile: jest.fn(),
    send: jest.fn(),
  };
}

function controller(filename: string, filePath = `/medias/${filename}`) {
  const c = Object.create(StreamingController.prototype) as StreamingController;
  (c as unknown as { subtitleStreamService: unknown }).subtitleStreamService = {
    getSubtitleFileForDownload: async () => ({ path: filePath, filename }),
  };
  return c;
}

function download(c: StreamingController, res: unknown) {
  return (
    c as unknown as {
      subtitleDownload: (id: number, u: undefined, r: unknown) => Promise<void>;
    }
  ).subtitleDownload(42, undefined, res);
}

describe('StreamingController.subtitleDownload', () => {
  it('names the attachment after the file on disk', async () => {
    const res = fakeRes();
    await download(controller('Show - S01E01.fr.srt'), res);
    expect(res.attachment).toHaveBeenCalledWith('Show - S01E01.fr.srt');
    expect(res.sendFile).toHaveBeenCalledWith('/medias/Show - S01E01.fr.srt');
  });

  it('hands a non-ASCII name over untouched, encoding being Express job', async () => {
    const res = fakeRes();
    await download(controller('Amélie – "ça".srt'), res);
    expect(res.attachment).toHaveBeenCalledWith('Amélie – "ça".srt');
  });
});
