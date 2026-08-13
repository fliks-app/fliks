import { getMetadataArgsStorage } from 'typeorm';
import { Episode } from './episode.entity';

/**
 * The dev schema sync drops any index the entity metadata does not declare, so an index that
 * lives only in its migration disappears on the next boot and takes its query plan with it.
 */
describe('Episode index metadata', () => {
  it('declares the season-coverage index its migration creates', () => {
    const declared = getMetadataArgsStorage()
      .indices.filter((i) => i.target === Episode)
      .map((i) => i.name);

    expect(declared).toContain('idx_episodes_season_hasfile_end');
  });
});
