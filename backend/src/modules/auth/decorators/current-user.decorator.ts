import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../users/entities/user.entity';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: User }>();
    return request.user;
  },
);
