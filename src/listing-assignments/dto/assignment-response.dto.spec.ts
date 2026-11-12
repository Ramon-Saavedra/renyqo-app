import {
  ListingResponsibilityResponseDto,
  ListingTransferRequestResponseDto,
} from './assignment-response.dto';

describe('Assignment HTTP response allowlists', () => {
  it('maps both responsibility paths identically without SQL/evidence fields', () => {
    const row = {
      id: 'listing',
      workspace_id: 'workspace',
      responsible_membership_id: 'member',
      revision: 2,
      status: 'published',
    };
    const expected = {
      listingId: 'listing',
      workspaceId: 'workspace',
      responsibleMembershipId: 'member',
      revision: 2,
    };
    expect(new ListingResponsibilityResponseDto(row)).toEqual(expected);
    expect(
      new ListingResponsibilityResponseDto({
        ...row,
        assignment_sequence: 9,
      } as typeof row),
    ).toEqual(expected);
  });

  it('serializes transfer business fields only, including future unknown columns', () => {
    const row = {
      id: 'transfer',
      listingId: 'listing',
      workspaceId: 'workspace',
      status: 'REQUESTED' as const,
      sourceMembershipId: 'source',
      targetMembershipId: 'target',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      expiresAt: new Date('2026-11-02T00:00:00Z'),
      commandId: 'private',
      correlationId: 'private',
      expectedOwnershipRevision: 4,
      expectedListingRevision: 3,
      expectedSourceRevision: 2,
      expectedTargetRevision: 1,
      decidedAt: new Date(),
      decidedByMembershipId: 'private',
      futureInternalField: 'private',
    };
    expect(
      JSON.parse(JSON.stringify(new ListingTransferRequestResponseDto(row))),
    ).toEqual({
      id: row.id,
      listingId: row.listingId,
      workspaceId: row.workspaceId,
      status: 'REQUESTED',
      sourceMembershipId: row.sourceMembershipId,
      targetMembershipId: row.targetMembershipId,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    });
  });
});
