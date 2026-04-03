import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RootFolder } from './entities/root-folder.entity';
import { RootFoldersService } from './root-folders.service';
import { RootFoldersController } from './root-folders.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [TypeOrmModule.forFeature([RootFolder]), AuthModule, SettingsModule],
  controllers: [RootFoldersController],
  providers: [RootFoldersService],
  exports: [RootFoldersService],
})
export class RootFoldersModule {}
