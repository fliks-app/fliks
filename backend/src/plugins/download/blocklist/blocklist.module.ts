import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { BlocklistService } from './blocklist.service';
import { AuthModule } from '../../../modules/auth/auth.module';
import { Indexer } from '../indexers/entities/indexer.entity';

/**
 * No `BlocklistController` here: this module is imported unconditionally
 * (`DownloadClientsModule`'s own `blockTorrent` needs the service), but the
 * HTTP route must disappear with `FLIKS_BUNDLES=` — so the controller is
 * mounted from `GrabModule` instead, which is gated and already has
 * `AuthModule` for the same guard pair.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BlocklistEntry, Indexer]), AuthModule],
  providers: [BlocklistService],
  exports: [BlocklistService],
})
export class BlocklistModule {}
