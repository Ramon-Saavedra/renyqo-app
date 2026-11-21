import { randomUUID } from 'node:crypto';
import {
  AuditContextFixture,
  contextCommand,
  effect,
} from './audit-context.fixture';
import type { RequiredAudit } from '../src/audit/context/required-audit';
jest.setTimeout(60000);
describe('Required audit transaction/effect boundary', () => {
  const f = new AuditContextFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('rolls back the test mutation if required effects are missing, even if the caller catches', async () => {
    const id = randomUUID();
    await expect(
      f.protectedWrites.run(
        f.owner,
        {
          workspaceId: f.w.id,
          action: 'audit.ledger.activated',
          resourceIds: [],
          purpose: 'OPERATIONAL',
        },
        { kind: 'BUSINESS' },
        () => Promise.resolve(),
        async (tx, ctx) => {
          try {
            await f.contexts.member(
              tx,
              ctx,
              contextCommand(['one', 'two']),
              async (audit) => {
                await tx.$executeRaw`INSERT INTO authz_test_resources(id,workspace_id) VALUES(${id}::uuid,${f.w.id}::uuid)`;
                await audit.append(effect('one'));
              },
            );
          } catch {
            /* The outer transaction must still fail to commit. */
          }
        },
      ),
    ).rejects.toBeDefined();
    expect(
      (await f.pool.query('SELECT FROM authz_test_resources WHERE id=$1', [id]))
        .rowCount,
    ).toBe(0);
    expect(await f.prisma.auditExecutionContext.count()).toBe(0);
  });
  it('rejects invalid payloads without committing a preceding test mutation', async () => {
    const id = randomUUID();
    await expect(
      f.run(contextCommand(), async (audit, tx) => {
        await tx.$executeRaw`INSERT INTO authz_test_resources(id,workspace_id) VALUES(${id}::uuid,${f.w.id}::uuid)`;
        return audit.append({
          ...effect(),
          metadata: { password: 'never log this' },
        } as unknown as Parameters<RequiredAudit['append']>[0]);
      }),
    ).rejects.toBeDefined();
    expect(
      (await f.pool.query('SELECT FROM authz_test_resources WHERE id=$1', [id]))
        .rowCount,
    ).toBe(0);
  });
  it('fails closed on duplicate effects and exposes no generic exactly-once claim', async () => {
    const command = contextCommand();
    const mutation = randomUUID();
    await f.run(command, (audit) => audit.append(effect()));
    await expect(
      f.run(command, async (audit, tx) => {
        await tx.$executeRaw`INSERT INTO authz_test_resources(id,workspace_id) VALUES(${mutation}::uuid,${f.w.id}::uuid)`;
        return audit.append(effect());
      }),
    ).rejects.toThrow('Required audit append failed');
    expect(
      await f.prisma.auditEvent.count({
        where: { commandId: command.commandId },
      }),
    ).toBe(1);
    expect(
      (
        await f.pool.query('SELECT FROM authz_test_resources WHERE id=$1', [
          mutation,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('does not append again when an existing receipt is replayed before binding context', async () => {
    const command = contextCommand(),
      run = () =>
        f.protectedWrites.run(
          f.owner,
          {
            workspaceId: f.w.id,
            action: 'audit.ledger.activated',
            resourceIds: [],
            purpose: 'OPERATIONAL',
          },
          { kind: 'BUSINESS' },
          () => Promise.resolve(),
          async (tx, ctx) => {
            const rows = await tx.$queryRaw<
              { protected_result: string }[]
            >`SELECT protected_result FROM authz_test_receipts WHERE workspace_id=${f.w.id}::uuid AND command_id=${command.commandId}::uuid`;
            if (rows[0]) return rows[0].protected_result;
            return f.contexts.member(tx, ctx, command, async (audit) => {
              const id = await audit.append(effect());
              await tx.$executeRaw`INSERT INTO authz_test_receipts VALUES(${f.w.id}::uuid,${f.w.ownerUser}::uuid,${command.commandId}::uuid,'test','fingerprint',${id})`;
              return id;
            });
          },
        );
    // The test-only receipt is explicitly granted in this isolated schema.
    await f.pool.query(
      `GRANT SELECT,INSERT ON authz_test_receipts TO "${f.applicationLogin}"`,
    );
    expect(await run()).toBe(await run());
    expect(
      await f.prisma.auditEvent.count({
        where: { commandId: command.commandId },
      }),
    ).toBe(1);
  });
  it('rejects an escaped handle and leaves no committed execution bookkeeping', async () => {
    let escaped!: RequiredAudit;
    await f.run(contextCommand(), async (audit) => {
      escaped = audit;
      return audit.append(effect());
    });
    await expect(escaped.append(effect())).rejects.toBeDefined();
    expect(await f.prisma.auditExecutionContext.count()).toBe(0);
  });
  it('rejects raw unclosed contexts at transaction end', async () => {
    await expect(
      f.applicationSql(f.w.id, (c) =>
        c.query(
          `SELECT open_human_audit_execution($1,$2,1,'SESSION_BOUND',$3,$4,1,NULL,$5::jsonb)`,
          [
            f.w.id,
            f.w.ownerUser,
            f.owner.sessionId,
            f.w.owner,
            JSON.stringify(contextCommand()),
          ],
        ),
      ),
    ).rejects.toBeDefined();
  });
});
