import { Injectable } from '@nestjs/common';
import { types } from 'node:util';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  HumanAuthority,
  ReadPolicy,
} from './domain/authorization.types';
import { captureHumanAuthority } from './domain/authority-reference';
import {
  assertSameObservation,
  captureRequirement,
} from './domain/workspace-authority.policy';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';

// Unlike void, undefined rejects async/Promise-returning callbacks in TypeScript.
export type SynchronousHandoff<T> = (
  value: T,
  context: AuthorizationContext,
) => undefined;

@Injectable()
export class AuthorizedWorkspaceReads {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
  ) {}

  private async observe(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
  ) {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    return this.resolver.read(this.prisma, principal, selection, (context) =>
      Promise.resolve(context),
    );
  }

  async query<T>(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    policy: ReadPolicy,
    produce: (
      context: AuthorizationContext,
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T> {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    const observed = await this.observe(principal, selection);
    await policy(observed, selection);
    // Async preparation/policy is outside the transaction. Reauthorize and query
    // together in a fresh short scope; producer uses this tx, never root Prisma.
    return this.resolver.read(
      this.prisma,
      principal,
      selection,
      (current, tx) => {
        assertSameObservation(observed, current);
        return produce(current, tx);
      },
    );
  }

  async handoff<T>(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    policy: ReadPolicy,
    value: T,
    send: SynchronousHandoff<T>,
  ): Promise<void> {
    if (types.isAsyncFunction(send))
      throw new TypeError('Handoff must be synchronous');
    const context = await this.query(
      authority,
      requirement,
      policy,
      (current) => Promise.resolve(current),
    );
    // query has committed/closed its short scope before synchronous enqueue.
    const result: unknown = send(value, context);
    if (result !== undefined) {
      // Catch an invalid native Promise's rejection without awaiting/accepting it.
      // Calling an unchecked callback cannot undo work it already started.
      if (types.isPromise(result)) void result.catch(() => undefined);
      throw new TypeError('Synchronous handoff must return undefined');
    }
  }
}
