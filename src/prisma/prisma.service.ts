import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';
import { assertApplicationRuntime } from '../provider-tenancy/application-runtime-verifier';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly databaseSchema: string;
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env['DATABASE_URL']!;
    const schema =
      new URL(connectionString).searchParams.get('schema') ?? 'public';
    const pool = new Pool({ connectionString });
    super({ adapter: new PrismaPg(pool, { schema }) });
    this.pool = pool;
    this.databaseSchema = schema;
  }

  getDatabaseSchema(): string {
    return this.databaseSchema;
  }

  getSharedPool(): Pool {
    return this.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    if (process.env['NODE_ENV'] === 'production')
      await assertApplicationRuntime(this, this.databaseSchema);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
