import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Role } from '../../generated/prisma/enums';
import type { SafeUser } from '../../users/types/safe-user.type';

@Injectable()
export class ProviderOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as SafeUser | undefined;
    return user?.role === Role.PROVIDER;
  }
}
