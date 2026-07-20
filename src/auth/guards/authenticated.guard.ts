import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UserStatus } from '../../generated/prisma/enums';
import { isSafeUser } from '../../users/types/safe-user.type';

@Injectable()
export class AuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    return (
      request.isAuthenticated() &&
      isSafeUser(request.user) &&
      request.user.status === UserStatus.ACTIVE
    );
  }
}
