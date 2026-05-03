import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlocklistEntry } from './entities/blocklist-entry.entity';
import { BlocklistService } from './blocklist.service';
import { BlocklistController } from './blocklist.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([BlocklistEntry]), AuthModule],
  controllers: [BlocklistController],
  providers: [BlocklistService],
  exports: [BlocklistService],
})
export class BlocklistModule {}
