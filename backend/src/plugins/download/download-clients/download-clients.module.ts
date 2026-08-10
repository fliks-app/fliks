import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { DownloadHistory } from '../../../modules/media/entities/download-history.entity';
import { StalledCheck } from '../../../modules/scheduler/entities/stalled-check.entity';
import { CleanupProfile } from '../../../modules/cleanup-profiles/entities/cleanup-profile.entity';
import { QbittorrentService } from './qbittorrent.service';
import { DownloadClientsService } from './download-clients.service';
import { DownloadClientsController } from './download-clients.controller';
import { AuthModule } from '../../../modules/auth/auth.module';
import { TorrentHistoryMatcher } from '../../../modules/media/torrent-history-matcher.service';
import { BlocklistModule } from '../../../modules/blocklist/blocklist.module';

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
