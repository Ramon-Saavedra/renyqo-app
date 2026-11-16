import type { AuthorizationContext } from '../domain/authorization.types';
import {
  PROVIDER_CAPABILITIES,
  isProviderCapability,
  type ProviderCapability,
} from './provider-capability';
import { providerDefaultCapabilities } from './provider-default-capabilities';
import {
  allowsProviderOperation,
  assertProviderOperation,
} from './provider-capability-policy';
import { PROVIDER_OPERATION_REQUIREMENTS } from '../operations/provider-operation-requirements';
import * as operations from '../operations/provider-operation';
import { captureRequirement } from '../domain/workspace-authority.policy';

const agent = { role: 'AGENT', status: 'ACTIVE' } as AuthorizationContext;
const owner = { ...agent, role: 'OWNER' } as AuthorizationContext;
const set = (...capabilities: ProviderCapability[]) => new Set(capabilities);

describe('Provider capability contract', () => {
  it.each(Object.entries(PROVIDER_OPERATION_REQUIREMENTS))(
    '%s requires every member of its allOf set',
    (operation, required) => {
      const available = new Set<ProviderCapability>(required);
      expect(allowsProviderOperation(available, operation)).toBe(true);
      for (const capability of required) {
        const missing = new Set(available);
        missing.delete(capability);
        expect(allowsProviderOperation(missing, operation)).toBe(false);
      }
    },
  );
  it('does not allow a provider operation to be paired with another delegated action', () => {
    expect(() =>
      captureRequirement({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        action: 'listing.write',
        providerOperation: 'listing.read',
        purpose: 'OPERATIONAL',
        resourceIds: [],
      }),
    ).toThrow('Invalid authority requirement');
  });
  it('defines exactly the agreed catalog including reserved FINANCIAL_READ', () => {
    expect(PROVIDER_CAPABILITIES).toHaveLength(16);
    expect(new Set(PROVIDER_CAPABILITIES).size).toBe(16);
    expect(isProviderCapability('FINANCIAL_READ')).toBe(true);
    for (const value of [
      'billing.manage',
      'financial.read',
      '__proto__',
      null,
    ]) {
      expect(isProviderCapability(value)).toBe(false);
    }
  });
  it('covers every operation exactly once with known capability requirements', () => {
    const identifiers = Object.values(operations).flat();
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(Object.keys(PROVIDER_OPERATION_REQUIREMENTS).sort()).toEqual(
      identifiers.sort(),
    );
    for (const allOf of Object.values(PROVIDER_OPERATION_REQUIREMENTS)) {
      expect(allOf.every(isProviderCapability)).toBe(true);
      expect(allOf).not.toContain('FINANCIAL_READ');
    }
  });
  it.each(['OWNER', 'AGENT'] as const)(
    'keeps %s operational defaults and financial authority reserved',
    (role) => {
      const available = providerDefaultCapabilities({ role, status: 'ACTIVE' });
      expect(available.has('DOCUMENT_CONTENT_READ')).toBe(true);
      expect(available.has('LISTING_CREATE')).toBe(true);
      expect(available.has('FINANCIAL_READ')).toBe(false);
      expect(available.has('LISTING_TRANSFER_REQUEST')).toBe(role === 'AGENT');
    },
  );
  it.each(['SUSPENDED', 'REMOVED'])(
    'gives %s memberships no authority',
    (status) => {
      expect(providerDefaultCapabilities({ role: 'OWNER', status }).size).toBe(
        0,
      );
      expect(() =>
        assertProviderOperation(
          { ...owner, status } as AuthorizationContext,
          'listing.order',
        ),
      ).toThrow();
    },
  );
  it('denies unknown roles, operations, capabilities and prototype keys', () => {
    expect(
      providerDefaultCapabilities({ role: 'ADMIN', status: 'ACTIVE' }).size,
    ).toBe(0);
    for (const operation of [
      'application.write',
      'billing.manage',
      '__proto__',
      'toString',
      null,
    ]) {
      expect(
        allowsProviderOperation(new Set(PROVIDER_CAPABILITIES), operation),
      ).toBe(false);
    }
    expect(
      allowsProviderOperation(
        new Set(['INVALID']) as unknown as Set<ProviderCapability>,
        'listing.read',
      ),
    ).toBe(false);
  });
  it('allows metadata without granting content, review or verification decisions', () => {
    const available = set('APPLICATION_READ', 'DOCUMENT_READ');
    expect(allowsProviderOperation(available, 'document.read')).toBe(true);
    for (const operation of [
      'document.content.read',
      'document.review',
      'verification.decide',
    ]) {
      expect(allowsProviderOperation(available, operation)).toBe(false);
    }
  });
  it('separates file acknowledgement from verification decisions', () => {
    const available = set(
      'APPLICATION_READ',
      'DOCUMENT_READ',
      'DOCUMENT_REVIEW',
    );
    expect(allowsProviderOperation(available, 'document.review')).toBe(true);
    expect(allowsProviderOperation(available, 'verification.decide')).toBe(
      false,
    );
    available.delete('DOCUMENT_REVIEW');
    available.add('VERIFICATION_MANAGE');
    expect(allowsProviderOperation(available, 'document.review')).toBe(false);
    expect(allowsProviderOperation(available, 'verification.decide')).toBe(
      true,
    );
  });
  it.each(['DOCUMENT_READ', 'VIEWING_READ', 'CONVERSATION_READ'] as const)(
    'requires %s for complete composite responses',
    (missing) => {
      const available = new Set(providerDefaultCapabilities(agent));
      available.delete(missing);
      for (const operation of [
        'application.workspace',
        'attention.read',
        'listing.overview',
        'applications.active',
      ]) {
        expect(allowsProviderOperation(available, operation)).toBe(false);
      }
    },
  );
  it('does not grant any runtime financial or billing operation', () => {
    for (const operation of [
      'financial.read',
      'financial.report',
      'billing.manage',
    ]) {
      expect(allowsProviderOperation(set('FINANCIAL_READ'), operation)).toBe(
        false,
      );
    }
  });
});
