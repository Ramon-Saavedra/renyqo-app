import { ConflictException, BadRequestException } from '@nestjs/common';
import type { ProviderWorkspace } from '../../generated/prisma/client';

export function workspaceDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 160)
    throw new BadRequestException(
      'Workspace display name must be 1–160 characters',
    );
  return name;
}

export function organizationLegalName(value: string | null): string | null {
  if (value === null) return null;
  const name = value.trim();
  if (!name || name.length > 240)
    throw new BadRequestException('Legal name must be 1–240 characters');
  return name;
}

export function requireWorkspaceRevision(
  workspace: ProviderWorkspace,
  expectedRevision: number,
): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    workspace.revision !== expectedRevision
  )
    throw new ConflictException('Workspace revision changed');
}

export function requireExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ConflictException('Expected revision must be a positive integer');
}

export function requireWorkspaceState(
  workspace: ProviderWorkspace,
  state: ProviderWorkspace['lifecycleStatus'],
): void {
  if (workspace.lifecycleStatus !== state)
    throw new ConflictException(`Workspace must be ${state}`);
}

// Canonical future ownership boundary. This phase deliberately does not add a
// second ownership column to existing listings or migrate their authorization.
export type WorkspaceOwnedListingReference = Readonly<{
  listingId: string;
  workspaceId: string;
}>;
