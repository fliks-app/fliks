import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FliksRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';

/** Entities only: the requests routes and lifecycle moved to fliks-server. */
@Module({
  imports: [
    TypeOrmModule.forFeature([FliksRequest, RequestComment, AutoApprovalRule]),
  ],
  exports: [TypeOrmModule],
})
export class RequestsModule {}
