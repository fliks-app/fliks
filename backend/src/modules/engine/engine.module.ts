import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { LiveTvModule } from '../livetv/livetv.module';
import { StreamingModule } from '../streaming/streaming.module';
import { User } from '../users/entities/user.entity';
import {
  EngineHostGuard,
  EngineResolverController,
} from './engine-resolver.controller';
import { EngineResolverService } from './engine-resolver.service';
import { EngineService } from './engine.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    AuthModule,
    StreamingModule,
    LiveTvModule,
  ],
  controllers: [EngineResolverController],
  providers: [EngineService, EngineResolverService, EngineHostGuard],
  exports: [EngineService],
})
export class EngineModule {}
