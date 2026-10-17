import { DataSource } from 'typeorm';
import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { DEFAULT_DATA_SOURCE_NAME } from '@nestjs/typeorm/dist/typeorm.constants';
import './app.module';

// `autoLoadEntities` only knows what a `forFeature` registered: a relation to anything else fails at boot.
describe('registered entities', () => {
  it('build their metadata with every relation target registered', async () => {
    const entities = EntitiesMetadataStorage.getEntitiesByDataSource(DEFAULT_DATA_SOURCE_NAME);
    expect(entities.length).toBeGreaterThan(0);
    const ds = new DataSource({ type: 'postgres', entities });
    await expect((ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas()).resolves.toBeUndefined();
  });
});
