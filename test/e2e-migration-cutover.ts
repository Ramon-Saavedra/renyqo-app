import type { PoolClient } from 'pg';

/** Listing workspace migration refuses legacy rows; clear graph before applying it on upgrade paths. */
export const LISTING_WORKSPACE_CUTOVER_MIGRATION =
  '20261108150000_listing_workspace_assignment';

export async function clearLegacyListingsBeforeWorkspaceCutover(
  client: PoolClient,
): Promise<void> {
  await client.query(`
    TRUNCATE application_document_files, application_document_requests,
    applications, listings
    RESTART IDENTITY CASCADE
  `);
}
