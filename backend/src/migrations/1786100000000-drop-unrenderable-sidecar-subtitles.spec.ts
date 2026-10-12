import type { QueryRunner } from 'typeorm';
import { DropUnrenderableSidecarSubtitles1786100000000 } from './1786100000000-drop-unrenderable-sidecar-subtitles';

describe('DropUnrenderableSidecarSubtitles', () => {
  it('deletes only codec-less rows of the unrenderable sidecar extensions', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new DropUnrenderableSidecarSubtitles1786100000000().up({
      query,
    } as unknown as QueryRunner);

    const sql = (query.mock.calls as [string][])[0][0];
    expect(sql).toMatch(/^DELETE FROM "subtitle_files"/);
    expect(sql).toContain('"codec" IS NULL');
    const re = new RegExp(/'([^']+)'/.exec(sql)![1], 'i');
    for (const f of ['a.en.sub', 'a.MKS', 'a.smi', 'a.sami'])
      expect(re.test(f)).toBe(true);
    for (const f of ['a.en.srt', 'a.sup', 'a.vtt', 'sub.srt'])
      expect(re.test(f)).toBe(false);
  });
});
