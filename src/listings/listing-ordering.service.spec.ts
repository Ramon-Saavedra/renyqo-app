import {
  UNIT_WORKSPACE_ID,
  unitProvider,
  unitProviderOperations,
} from '../../test/unit-workspace-authority';
import type { ProviderListingAccess } from '../provider-authorization/provider-listing-access';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Listing, Prisma } from '../generated/prisma/client';
import { ListingOrderingService } from './listing-ordering.service';

const PROVIDER_ID = UNIT_WORKSPACE_ID;
const OTHER_PROVIDER_ID = '00000000-0000-4000-8000-000000000002';

type StoredListing = {
  id: string;
  workspaceId: string;
  displayOrder: number;
  title: string;
};

type FindManyArgs = {
  where: { workspaceId: string };
  orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }];
  select: { id: true; displayOrder: true };
};

type FindUniqueArgs = {
  where: { id: string };
};

type UpdateArgs = {
  where: { id: string };
  data: { displayOrder: number };
};

const GAPPED_PROVIDER_LISTINGS: readonly StoredListing[] = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    workspaceId: PROVIDER_ID,
    displayOrder: 1,
    title: '2-Zimmer-Wohnung in Bawinkel',
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    workspaceId: PROVIDER_ID,
    displayOrder: 2,
    title: '9-Zimmer-Haus in Bawinkel',
  },
  {
    id: '00000000-0000-4000-8000-000000000013',
    workspaceId: PROVIDER_ID,
    displayOrder: 3,
    title: 'Zimmer in Nordhorn',
  },
  {
    id: '00000000-0000-4000-8000-000000000014',
    workspaceId: PROVIDER_ID,
    displayOrder: 4,
    title: '3-Zimmer-Wohnung in Santiago',
  },
  {
    id: '00000000-0000-4000-8000-000000000015',
    workspaceId: PROVIDER_ID,
    displayOrder: 6,
    title: '4,5-Zimmer-Haus in Maracaibo',
  },
  {
    id: '00000000-0000-4000-8000-000000000016',
    workspaceId: PROVIDER_ID,
    displayOrder: 7,
    title: '9,5-Zimmer-Haus in Calaceite',
  },
  {
    id: '00000000-0000-4000-8000-000000000017',
    workspaceId: PROVIDER_ID,
    displayOrder: 13,
    title: '5-Zimmer-Haus in Berlin',
  },
  {
    id: '00000000-0000-4000-8000-000000000018',
    workspaceId: PROVIDER_ID,
    displayOrder: 16,
    title: '4,5-Zimmer-Haus in Cocoland',
  },
];

const EXPECTED_VISIBLE_TITLES = [
  '2-Zimmer-Wohnung in Bawinkel',
  '9-Zimmer-Haus in Bawinkel',
  'Zimmer in Nordhorn',
  '3-Zimmer-Wohnung in Santiago',
  '5-Zimmer-Haus in Berlin',
  '4,5-Zimmer-Haus in Maracaibo',
  '9,5-Zimmer-Haus in Calaceite',
  '4,5-Zimmer-Haus in Cocoland',
];

function createHarness(seed: readonly StoredListing[]) {
  const rows = seed.map((listing) => ({ ...listing }));

  const listing = {
    findMany: jest.fn((args: FindManyArgs) =>
      rows
        .filter((row) => row.workspaceId === args.where.workspaceId)
        .sort(
          (left, right) =>
            left.displayOrder - right.displayOrder ||
            left.id.localeCompare(right.id),
        )
        .map((row) => ({ id: row.id, displayOrder: row.displayOrder })),
    ),
    findUnique: jest.fn((args: FindUniqueArgs) => {
      const row = rows.find((item) => item.id === args.where.id);
      return row ? ({ ...row } as Listing) : null;
    }),
    findUniqueOrThrow: jest.fn(
      (args: { where: { id: string; workspaceId: string } }) => {
        const row = rows.find(
          (item) =>
            item.id === args.where.id &&
            item.workspaceId === args.where.workspaceId,
        );
        if (!row) throw new NotFoundException('Listing not found');
        return { ...row };
      },
    ),
    update: jest.fn((args: UpdateArgs) => {
      const row = rows.find((item) => item.id === args.where.id);
      if (!row) {
        throw new Error(`Listing ${args.where.id} was not found`);
      }

      const collision = rows.some(
        (item) =>
          item.id !== row.id &&
          item.workspaceId === row.workspaceId &&
          item.displayOrder === args.data.displayOrder,
      );
      if (collision) {
        throw new Error(
          `Unique constraint failed on (workspaceId, displayOrder) for ${args.data.displayOrder}`,
        );
      }

      row.displayOrder = args.data.displayOrder;
      return { ...row } as Listing;
    }),
  };

  const tx = {
    listing,
    $queryRaw: jest.fn((query: TemplateStringsArray, workspaceId?: string) => {
      const text = Array.isArray(query) ? query.join(' ') : '';
      if (!text.includes('max(display_order)')) return [];
      const max = rows
        .filter((row) => row.workspaceId === workspaceId)
        .reduce((highest, row) => Math.max(highest, row.displayOrder), 0);
      return [{ next: max + 1 }];
    }),
  };

  const prisma = {
    $transaction: jest.fn(
      (operation: (client: Prisma.TransactionClient) => Promise<Listing>) =>
        operation(tx as unknown as Prisma.TransactionClient),
    ),
  };

  return {
    service: new ListingOrderingService(
      unitProviderOperations(tx) as unknown as ProviderListingAccess,
    ),
    rows,
    tx,
    prisma,
  };
}

function visibleTitles(rows: readonly StoredListing[], workspaceId: string) {
  return rows
    .filter((row) => row.workspaceId === workspaceId)
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        left.id.localeCompare(right.id),
    )
    .map((row) => row.title);
}

function displayOrders(rows: readonly StoredListing[], workspaceId: string) {
  return rows
    .filter((row) => row.workspaceId === workspaceId)
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        left.id.localeCompare(right.id),
    )
    .map((row) => row.displayOrder);
}

describe('ListingOrderingService', () => {
  describe('non-contiguous display orders', () => {
    let harness: ReturnType<typeof createHarness>;

    beforeEach(() => {
      harness = createHarness([
        ...GAPPED_PROVIDER_LISTINGS,
        {
          id: '00000000-0000-4000-8000-000000000021',
          workspaceId: OTHER_PROVIDER_ID,
          displayOrder: 4,
          title: 'Other provider listing',
        },
        {
          id: '00000000-0000-4000-8000-000000000022',
          workspaceId: OTHER_PROVIDER_ID,
          displayOrder: 9,
          title: 'Other provider second listing',
        },
      ]);
    });

    it('moves visible position 7 to visible position 5 and compacts to 1..N', async () => {
      const berlin = GAPPED_PROVIDER_LISTINGS[6];

      await harness.service.move(berlin.id, unitProvider(PROVIDER_ID), 5);

      expect(harness.tx.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: UNIT_WORKSPACE_ID, status: { not: 'RETIRED' } },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: { id: true, displayOrder: true },
        }),
      );
      expect(visibleTitles(harness.rows, PROVIDER_ID)).toEqual(
        EXPECTED_VISIBLE_TITLES,
      );
      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(new Set(displayOrders(harness.rows, PROVIDER_ID)).size).toBe(8);
      expect(displayOrders(harness.rows, OTHER_PROVIDER_ID)).toEqual([4, 9]);
    });

    it('moves the first visible listing to the last position', async () => {
      const first = GAPPED_PROVIDER_LISTINGS[0];

      await harness.service.move(first.id, unitProvider(PROVIDER_ID), 8);

      expect(visibleTitles(harness.rows, PROVIDER_ID)).toEqual([
        '9-Zimmer-Haus in Bawinkel',
        'Zimmer in Nordhorn',
        '3-Zimmer-Wohnung in Santiago',
        '4,5-Zimmer-Haus in Maracaibo',
        '9,5-Zimmer-Haus in Calaceite',
        '5-Zimmer-Haus in Berlin',
        '4,5-Zimmer-Haus in Cocoland',
        '2-Zimmer-Wohnung in Bawinkel',
      ]);
      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('moves the last visible listing to the first position', async () => {
      const last = GAPPED_PROVIDER_LISTINGS[7];

      await harness.service.move(last.id, unitProvider(PROVIDER_ID), 1);

      expect(visibleTitles(harness.rows, PROVIDER_ID)).toEqual([
        '4,5-Zimmer-Haus in Cocoland',
        '2-Zimmer-Wohnung in Bawinkel',
        '9-Zimmer-Haus in Bawinkel',
        'Zimmer in Nordhorn',
        '3-Zimmer-Wohnung in Santiago',
        '4,5-Zimmer-Haus in Maracaibo',
        '9,5-Zimmer-Haus in Calaceite',
        '5-Zimmer-Haus in Berlin',
      ]);
      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('moves a middle listing to another middle visible position', async () => {
      const santiago = GAPPED_PROVIDER_LISTINGS[3];

      await harness.service.move(santiago.id, unitProvider(PROVIDER_ID), 6);

      expect(visibleTitles(harness.rows, PROVIDER_ID)).toEqual([
        '2-Zimmer-Wohnung in Bawinkel',
        '9-Zimmer-Haus in Bawinkel',
        'Zimmer in Nordhorn',
        '4,5-Zimmer-Haus in Maracaibo',
        '9,5-Zimmer-Haus in Calaceite',
        '3-Zimmer-Wohnung in Santiago',
        '5-Zimmer-Haus in Berlin',
        '4,5-Zimmer-Haus in Cocoland',
      ]);
      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('compacts gaps when the listing is already at the requested visible position', async () => {
      const nordhorn = GAPPED_PROVIDER_LISTINGS[2];

      await harness.service.move(nordhorn.id, unitProvider(PROVIDER_ID), 3);

      expect(visibleTitles(harness.rows, PROVIDER_ID)).toEqual(
        GAPPED_PROVIDER_LISTINGS.map((listing) => listing.title),
      );
      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('rejects a position above the visible listing count', async () => {
      const berlin = GAPPED_PROVIDER_LISTINGS[6];

      await expect(
        harness.service.move(berlin.id, unitProvider(PROVIDER_ID), 16),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 6, 7, 13, 16,
      ]);
      expect(harness.tx.listing.update).not.toHaveBeenCalled();
    });

    it('allocates the next rank from the current maximum without compacting gaps', async () => {
      await expect(
        harness.service.getNextDisplayOrder(
          harness.tx as unknown as Prisma.TransactionClient,
          PROVIDER_ID,
        ),
      ).resolves.toBe(17);

      expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([
        1, 2, 3, 4, 6, 7, 13, 16,
      ]);
      expect(displayOrders(harness.rows, OTHER_PROVIDER_ID)).toEqual([4, 9]);
    });
  });

  it('leaves an already contiguous order unchanged when the visible position does not change', async () => {
    const harness = createHarness([
      {
        id: '00000000-0000-4000-8000-000000000031',
        workspaceId: PROVIDER_ID,
        displayOrder: 1,
        title: 'First',
      },
      {
        id: '00000000-0000-4000-8000-000000000032',
        workspaceId: PROVIDER_ID,
        displayOrder: 2,
        title: 'Second',
      },
      {
        id: '00000000-0000-4000-8000-000000000033',
        workspaceId: PROVIDER_ID,
        displayOrder: 3,
        title: 'Third',
      },
    ]);

    await harness.service.move(
      '00000000-0000-4000-8000-000000000032',
      unitProvider(PROVIDER_ID),
      2,
    );

    expect(displayOrders(harness.rows, PROVIDER_ID)).toEqual([1, 2, 3]);
    expect(harness.tx.listing.update).not.toHaveBeenCalled();
  });

  it('rejects a non-positive position before opening a transaction', () => {
    const harness = createHarness([]);

    expect(() =>
      harness.service.move(
        '00000000-0000-4000-8000-000000000031',
        unitProvider(PROVIDER_ID),
        0,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a listing owned by another provider', async () => {
    const harness = createHarness([
      {
        id: '00000000-0000-4000-8000-000000000041',
        workspaceId: OTHER_PROVIDER_ID,
        displayOrder: 1,
        title: 'Foreign listing',
      },
    ]);

    await expect(
      harness.service.move(
        '00000000-0000-4000-8000-000000000041',
        unitProvider(PROVIDER_ID),
        1,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 1 when the provider has no listings', async () => {
    const harness = createHarness([]);

    await expect(
      harness.service.getNextDisplayOrder(
        harness.tx as unknown as Prisma.TransactionClient,
        PROVIDER_ID,
      ),
    ).resolves.toBe(1);
  });

  it('returns the next contiguous rank without rewriting an already compact order', async () => {
    const harness = createHarness([
      {
        id: '00000000-0000-4000-8000-000000000051',
        workspaceId: PROVIDER_ID,
        displayOrder: 1,
        title: 'First',
      },
      {
        id: '00000000-0000-4000-8000-000000000052',
        workspaceId: PROVIDER_ID,
        displayOrder: 2,
        title: 'Second',
      },
    ]);

    await expect(
      harness.service.getNextDisplayOrder(
        harness.tx as unknown as Prisma.TransactionClient,
        PROVIDER_ID,
      ),
    ).resolves.toBe(3);

    expect(harness.tx.listing.update).not.toHaveBeenCalled();
  });
});
