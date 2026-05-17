import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const canActivate = super.canActivate(context) as
      | boolean
      | Promise<boolean>;
    const result: boolean =
      typeof canActivate === 'boolean' ? canActivate : await canActivate;
    if (!result) return false;
    const request = context.switchToHttp().getRequest<Request>();
    await super.logIn(request);
    return result;
  }
}
