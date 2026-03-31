import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Indexer } from './entities/indexer.entity';
import { IndexerStat } from './entities/indexer-stat.entity';
import { Tag } from '../tags/entities/tag.entity';
import { TorznabService } from './torznab.service';
import { IndexersService } from './indexers.service';
import { IndexersController } from './indexers.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Indexer, IndexerStat, Tag]), AuthModule],
  controllers: [IndexersController],
  providers: [
    TorznabService,
    IndexersService,
  ],
  exports: [
    TypeOrmModule,
    TorznabService,
  ],
})
export class IndexersModule {}
