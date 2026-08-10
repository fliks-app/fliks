import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Indexer } from './entities/indexer.entity';
import { IndexerStat } from './entities/indexer-stat.entity';
import { TorznabService } from './torznab.service';
import { IndexerThrottle } from './indexer-throttle.service';
import { IndexersService } from './indexers.service';
import { IndexersController } from './indexers.controller';
import { AuthModule } from '../../../modules/auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Indexer, IndexerStat]), AuthModule],
  controllers: [IndexersController],
  providers: [TorznabService, IndexerThrottle, IndexersService],
  exports: [TypeOrmModule, TorznabService],
})
export class IndexersModule {}
