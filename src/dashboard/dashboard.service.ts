import { Injectable } from '@nestjs/common';

import { ListingsService } from '../listings/listings.service';
import type {
  DashboardSummary,
  RecentListingSummary,
} from './types/dashboard-summary.type';

@Injectable()
export class DashboardService {
  constructor(private readonly listingsService: ListingsService) {}

  async getSummary(providerId: string): Promise<DashboardSummary> {
    const [objectsCount, draftsCount, fullListings] = await Promise.all([
      this.listingsService.countByProvider(providerId),
      this.listingsService.countDraftsByProvider(providerId),
      this.listingsService.findRecentByProvider(providerId, 5),
    ]);

    const recentListings: RecentListingSummary[] = fullListings.map(
      ({ id, title, status, city, objectType, coldRent, createdAt }) => ({
        id,
        title,
        status,
        city,
        objectType,
        coldRent,
        createdAt,
      }),
    );

    return {
      objectsCount,
      draftsCount,
      newApplicationsCount: 0,
      recentListings,
    };
  }
}
