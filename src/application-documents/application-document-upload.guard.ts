import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { isSafeUser } from '../users/types/safe-user.type';
import { ApplicationDocumentService } from './application-document.service';

@Injectable()
export class ApplicationDocumentUploadGuard implements CanActivate {
  constructor(private readonly documents: ApplicationDocumentService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const applicationId = request.params['applicationId'];
    const requestId = request.params['requestId'];
    if (!isSafeUser(request.user)) throw new UnauthorizedException();
    if (
      typeof applicationId !== 'string' ||
      typeof requestId !== 'string' ||
      !isUUID(applicationId, '4') ||
      !isUUID(requestId, '4')
    )
      throw new BadRequestException(
        'Valid application and request IDs required',
      );
    await this.documents.authorizeUpload(
      applicationId,
      requestId,
      request.user.id,
    );
    return true;
  }
}
