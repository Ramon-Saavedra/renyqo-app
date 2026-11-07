import { Injectable } from '@nestjs/common';
import { types } from 'node:util';
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

  private async current(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    policy: ReadPolicy,
  ) {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    const observed = await this.resolver.resolve(
      this.prisma,
      principal,
      selection,
    );
    await policy(observed, selection);
    // An async policy may have waited. Revalidate immediately before producing
    // results/handoff, without a long-lived read transaction or cached allow.
    const current = await this.resolver.resolve(
      this.prisma,
      principal,
      selection,
    );
    assertSameObservation(observed, current);
    return current;
  }

  async query<T>(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    policy: ReadPolicy,
    produce: (context: AuthorizationContext) => Promise<T>,
  ): Promise<T> {
    return produce(await this.current(authority, requirement, policy));
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
    const context = await this.current(authority, requirement, policy);
    const result: unknown = send(value, context);
    if (result !== undefined) {
      // Catch an invalid native Promise's rejection without awaiting/accepting it.
      // Calling an unchecked callback cannot undo work it already started.
      if (types.isPromise(result)) void result.catch(() => undefined);
      throw new TypeError('Synchronous handoff must return undefined');
    }
  }
}
