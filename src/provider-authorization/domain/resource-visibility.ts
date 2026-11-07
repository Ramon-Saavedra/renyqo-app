import { NotFoundException } from '@nestjs/common';
import type { AuthorizationContext } from './authorization.types';

export type WorkspaceResourceReference = Readonly<{
  id: string;
  workspaceId: string;
}>;

// Only accept a server-loaded canonical reference. This is a tenant consistency
// check, not an assignment/capability predicate or a legacy providerId fallback.
export function requireVisibleWorkspaceResource<
  T extends WorkspaceResourceReference,
>(context: AuthorizationContext, resource: T | null): T {
  if (!resource || resource.workspaceId !== context.workspaceId)
    throw new NotFoundException('Resource not found');
  return resource;
}
