import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SuitarrRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaModule } from '../media/media.module';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { AutoApprovalRulesController } from './auto-approval-rules.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SuitarrRequest,
      RequestComment,
      AutoApprovalRule,
    ]),
    AuthModule,
    NotificationsModule,
    MediaModule,
  ],
  controllers: [RequestsController, AutoApprovalRulesController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
