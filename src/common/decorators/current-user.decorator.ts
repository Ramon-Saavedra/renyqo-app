import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  isSafeUser,
  sanitizeSafeUser,
  type SafeUser,
} from '../../users/types/safe-user.type';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SafeUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!isSafeUser(request.user)) {
      throw new UnauthorizedException('Authentication required');
    }
    return sanitizeSafeUser(request.user);
  },
);
