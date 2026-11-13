import type { Socket } from 'socket.io-client';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';

export function waitForDomainEvents(
  socket: Socket,
  count: number,
  deadlineMs = 10_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const handler = (value: unknown) => {
      events.push(value);
      if (events.length >= count) {
        socket.off('domain-event', handler);
        clearTimeout(timer);
        resolve([...events]);
      }
    };
    socket.on('domain-event', handler);
    const timer = setTimeout(() => {
      socket.off('domain-event', handler);
      reject(
        new Error(
          `Expected ${count} domain-event emission(s), received ${events.length}`,
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });
}

export function waitForNextDomainEvent(
  socket: Socket,
  deadlineMs = 10_000,
): Promise<unknown> {
  return waitForDomainEvents(socket, 1, deadlineMs).then((rows) => rows[0]);
}

export async function waitUntilOutboxVisible(
  prisma: PrismaClient,
  id: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.outboxEvent.findUnique({
      where: { id },
      select: { id: true },
    });
    if (row) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Outbox row ${id} not visible`);
}

export async function waitUntilOutboxProcessed(
  prisma: PrismaClient,
  id: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.outboxEvent.findUnique({
      where: { id },
      select: { dispatchedAt: true },
    });
    if (row?.dispatchedAt) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Outbox row ${id} not processed`);
}

export async function dispatchOutboxUntilProcessed(
  dispatcher: OutboxDispatcherService,
  prisma: PrismaClient,
  eventId: string,
  maxRounds = 50,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const row = await prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: { dispatchedAt: true, nextAttemptAt: true },
    });
    if (!row) throw new Error(`Missing outbox row ${eventId}`);
    if (row.dispatchedAt) return;
    if (row.nextAttemptAt && row.nextAttemptAt > new Date()) {
      await prisma.outboxEvent.update({
        where: { id: eventId },
        data: { nextAttemptAt: new Date(0) },
      });
    }
    await dispatcher.dispatchOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Outbox row ${eventId} not processed after ${maxRounds} rounds`,
  );
}
