import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { StalledCheck } from '../scheduler/entities/stalled-check.entity';
import { CleanupProfile } from '../cleanup-profiles/entities/cleanup-profile.entity';
import { QbittorrentService } from './qbittorrent.service';
import { DownloadClientsService } from './download-clients.service';
import { DownloadClientsController } from './download-clients.controller';
import { AuthModule } from '../auth/auth.module';
import { TorrentHistoryMatcher } from '../media/torrent-history-matcher.service';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { FliksSchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DownloadClient,
      DownloadHistory,
      StalledCheck,
      CleanupProfile,
    ]),
    AuthModule,
    BlocklistModule,
    // forwardRef: FliksSchedulerModule already imports this module for
    // QbittorrentService/TorrentHistoryMatcher.
    forwardRef(() => FliksSchedulerModule),
  ],
  controllers: [DownloadClientsController],
  providers: [
    QbittorrentService,
    DownloadClientsService,
    TorrentHistoryMatcher,
  ],
  exports: [TypeOrmModule, QbittorrentService, TorrentHistoryMatcher],
})
export class DownloadClientsModule {}
