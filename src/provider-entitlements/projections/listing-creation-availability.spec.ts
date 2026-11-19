import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import { EntitlementResolver } from '../resolution/entitlement-resolver';
import type { CapacitySnapshot } from '../catalog/entitlement.types';
import * as defaults from '../../provider-authorization/capabilities/provider-default-capabilities';
import { ListingCreationAvailabilityProjection } from './listing-creation-availability';

describe('Operational listing creation availability', () => {
  const context: AuthorizationContext = {
    mode: 'SESSION_BOUND',
    userId: 'user',
    authVersion: 1,
    workspaceId: 'workspace',
    membershipId: 'member',
    role: 'AGENT',
    status: 'ACTIVE',
    membershipRevision: 1,
    workspaceLifecycle: 'ACTIVE',
  };
  const tx = {} as Prisma.TransactionClient;
  const capacity: CapacitySnapshot = {
    assigned: true,
    assignmentRevision: 1,
    plan: null,
    maxListings: 2,
    maxSeats: 3,
    usedListings: 0,
    acceptedSeats: 2,
    reservedSeats: 0,
    features: [],
    overLimit: [],
  };
  afterEach(() => jest.restoreAllMocks());
  function fixture(snapshot = capacity) {
    const resolver = new EntitlementResolver();
    const resolve = jest.spyOn(resolver, 'resolve').mockResolvedValue(snapshot);
    return {
      resolve,
      query: new ListingCreationAvailabilityProjection(resolver),
    };
  }
  it('uses canonical operation requirements and avoids entitlement reads when capability is missing', async () => {
    jest
      .spyOn(defaults, 'providerDefaultCapabilities')
      .mockReturnValue(new Set(['LISTING_CREATE']));
    const { query, resolve } = fixture();
    await expect(query.project(tx, context)).resolves.toEqual({
      allowed: false,
      reason: 'NOT_PERMITTED',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each(['OWNER', 'AGENT'] as const)(
    'returns the same safe allowed contract for %s',
    async (role) => {
      const { query, resolve } = fixture();
      await expect(query.project(tx, { ...context, role })).resolves.toEqual({
        allowed: true,
        reason: null,
      });
      expect(resolve).toHaveBeenCalledWith(tx, context.workspaceId);
    },
  );
  it.each([
    { ...capacity, assigned: false },
    { ...capacity, usedListings: 2 },
    { ...capacity, overLimit: ['SEATS' as const] },
    { ...capacity, overLimit: ['LISTINGS' as const] },
  ])(
    'coarsens growth failures without publishing their dimensions',
    async (snapshot) => {
      await expect(
        fixture(snapshot).query.project(tx, context),
      ).resolves.toEqual({
        allowed: false,
        reason: 'WORKSPACE_GROWTH_UNAVAILABLE',
      });
    },
  );
  it('does not translate unexpected resolver failures into an availability denial', async () => {
    const { query, resolve } = fixture();
    const error = new ConflictException('Unexpected failure');
    resolve.mockRejectedValue(error);
    await expect(query.project(tx, context)).rejects.toBe(error);
  });
});
