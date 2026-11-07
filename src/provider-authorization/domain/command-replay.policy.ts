import { ConflictException } from '@nestjs/common';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
} from './authorization.types';

export type CommandBinding = Readonly<{
  commandId: string;
  userId: string;
  workspaceId: string;
  action: string;
  inputFingerprint: string;
}>;

// Domain adapters own canonical input fingerprinting and receipt persistence.
// Invoke only after fresh authority AND resource/field authorization; this
// comparison never authorizes access to a receipt or its protected response.
export function bindCommand(
  context: AuthorizationContext,
  requirement: AuthorizationRequirement,
  commandId: string,
  inputFingerprint: string,
): CommandBinding {
  if (
    !commandId ||
    !inputFingerprint ||
    context.workspaceId !== requirement.workspaceId
  )
    throw new ConflictException('Invalid command binding');
  return Object.freeze({
    commandId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    action: requirement.action,
    inputFingerprint,
  });
}

export function assertSameCommand(
  expected: CommandBinding,
  stored: CommandBinding,
): void {
  if (
    expected.commandId !== stored.commandId ||
    expected.userId !== stored.userId ||
    expected.workspaceId !== stored.workspaceId ||
    expected.action !== stored.action ||
    expected.inputFingerprint !== stored.inputFingerprint
  )
    throw new ConflictException('Command input changed');
}
