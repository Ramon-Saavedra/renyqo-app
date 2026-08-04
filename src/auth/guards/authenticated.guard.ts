import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserStatus } from '../../generated/prisma/enums';
import { isSafeUser } from '../../users/types/safe-user.type';

@Injectable()
export class AuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.isAuthenticated() || !isSafeUser(request.user)) {
      throw new UnauthorizedException();
    }

    return request.user.status === UserStatus.ACTIVE;
  }
}
