import { BadRequestException } from '@nestjs/common';
import {
  isAuthorityId,
  positiveEpoch,
} from '../../provider-authorization/domain/authority-reference';
import type { AssignmentCommand } from './assignment.types';

export function captureAssignmentCommand(
  input: AssignmentCommand,
): Readonly<AssignmentCommand> {
  for (const value of [
    input.workspaceId,
    input.listingId,
    input.targetMembershipId,
    input.commandId,
    ...(input.correlationId ? [input.correlationId] : []),
  ])
    if (!isAuthorityId(value))
      throw new BadRequestException('Invalid assignment identifier');
  if (!positiveEpoch(input.expectedListingRevision))
    throw new BadRequestException('Expected listing revision required');
  return Object.freeze({
    ...input,
    workspaceId: input.workspaceId.toLowerCase(),
    listingId: input.listingId.toLowerCase(),
    targetMembershipId: input.targetMembershipId.toLowerCase(),
    commandId: input.commandId.toLowerCase(),
    correlationId: input.correlationId?.toLowerCase(),
  });
}
