import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { AuthModule } from '../auth/auth.module';
import { User } from '../users/entities/user.entity';
import { Library } from '../libraries/entities/library.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Role, User, Library]), AuthModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [TypeOrmModule, RolesService],
})
export class RolesModule {}
