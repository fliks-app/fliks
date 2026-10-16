import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiveTvModule } from '../livetv/livetv.module';
import { User } from '../users/entities/user.entity';
import { EngineResolverController } from './engine-resolver.controller';
import { EngineResolverService } from './engine-resolver.service';
import { EngineService } from './engine.service';
import { SettingsModule } from '../settings/settings.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User]), LiveTvModule, SettingsModule],
  controllers: [EngineResolverController],
  providers: [EngineService, EngineResolverService],
  exports: [EngineService],
})
export class EngineModule {}
