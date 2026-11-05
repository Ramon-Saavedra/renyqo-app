import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { VerificationRequirementService } from './verification-requirement.service';
import {
  VerificationCommandDto,
  verificationCommand,
} from './dto/verification-input.dto';

@Injectable()
export class VerificationCommandHttpService {
  constructor(private readonly requirements: VerificationRequirementService) {}

  async execute(
    applicationId: string,
    actorUserId: string,
    dto: VerificationCommandDto,
    key: string | undefined,
  ) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    try {
      // Return the transaction's receipt result directly, including on replay.
      return await this.requirements.execute(
        applicationId,
        actorUserId,
        verificationCommand(dto),
        key,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Transaction could not be completed'
      )
        throw new ServiceUnavailableException(
          'Please retry the command with the same idempotency key',
          { cause: error },
        );
      throw error;
    }
  }
}
