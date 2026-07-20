import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Role, UserStatus } from '../../generated/prisma/enums';
import { isSafeUser } from '../../users/types/safe-user.type';

@Injectable()
export class ApplicantOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    return (
      isSafeUser(user) &&
      user.status === UserStatus.ACTIVE &&
      user.role === Role.APPLICANT
    );
  }
}
