import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { BlocklistService } from './blocklist.service';
import { BlocklistController } from './blocklist.controller';
import { AuthModule } from '../auth/auth.module';
import { Indexer } from '../../plugins/download/indexers/entities/indexer.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BlocklistEntry, Indexer]), AuthModule],
  controllers: [BlocklistController],
  providers: [BlocklistService],
  exports: [BlocklistService],
})
export class BlocklistModule {}
