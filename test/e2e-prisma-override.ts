import type { Pool } from 'pg';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';

export function prismaServiceWithSharedPool(
  client: PrismaClient,
  pool: Pool,
  schema = 'public',
): PrismaService {
  return Object.assign(client, {
    getSharedPool: () => pool,
    getDatabaseSchema: () => schema,
  }) as unknown as PrismaService;
}
