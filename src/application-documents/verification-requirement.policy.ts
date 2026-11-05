import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApplicationDocumentType } from '../generated/prisma/enums';
import type { DocumentRequestInputDto } from './dto/document-input.dto';

export type RequirementInput = DocumentRequestInputDto & { subjectId?: string };
export type VerificationCommand =
  | { operation: 'REQUEST'; items: RequirementInput[] }
  | {
      operation: 'CANCEL' | 'REPLACE';
      requestId: string;
      expectedRevision?: number;
    }
  | {
      operation: 'DECIDE';
      requestId: string;
      expectedRevision: number;
      evidenceFileId: string | null;
      expectedDecisionId: string | null;
      decision: 'SATISFIED' | 'NOT_SATISFIED' | 'WAIVED';
      reason: string | null;
    };
export type VerificationCommandResult = {
  scopeRevision: number;
  requirements: {
    id: string;
    round: number;
    revision: number;
    state: 'OPEN' | 'CANCELLED' | 'SUPERSEDED' | 'LEGACY_CLOSED_UNKNOWN';
  }[];
};

export function requirementDefinition(input: DocumentRequestInputDto) {
  if (!Object.values(ApplicationDocumentType).includes(input.type))
    throw new BadRequestException('Invalid document type');
  if (input.type !== 'OTHER') {
    if (input.customLabel !== undefined)
      throw new BadRequestException('customLabel is only supported for OTHER');
    return { customLabel: null, definitionKey: input.type };
  }
  const label = input.customLabel
    ?.normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
  if (!label || label.length > 100 || !/^[\p{L}\p{N} .,'()&+/-]+$/u.test(label))
    throw new BadRequestException('OTHER requires a valid customLabel');
  return {
    customLabel: label,
    definitionKey: `OTHER:${createHash('sha256').update(label.toLocaleLowerCase('de-DE')).digest('hex')}`,
  };
}
