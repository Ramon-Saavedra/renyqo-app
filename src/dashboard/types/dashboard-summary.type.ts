import type { Listing } from '../../generated/prisma/client';

export type RecentListingSummary = Pick<
  Listing,
  'id' | 'title' | 'status' | 'city' | 'objectType' | 'coldRent' | 'createdAt'
>;

export interface DashboardSummary {
  objectsCount: number;
  draftsCount: number;
  newApplicationsCount: number;
  recentListings: RecentListingSummary[];
}
