import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { DownloadHistory } from '../entities/download-history.entity';
import { StalledCheck } from '../entities/stalled-check.entity';
import { QbittorrentService } from './qbittorrent.service';
import { DownloadClientsService } from './download-clients.service';
import { DownloadClientsController } from './download-clients.controller';
import { AuthModule } from '../../../modules/auth/auth.module';
import { TorrentHistoryMatcher } from '../torrent-history-matcher.service';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { SettingsModule } from '../../../modules/settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DownloadClient, DownloadHistory, StalledCheck]),
    AuthModule,
    BlocklistModule,
    SettingsModule,
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
