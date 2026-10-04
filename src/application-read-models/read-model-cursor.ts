import { BadRequestException } from '@nestjs/common';

export type ReadModelCursorKind =
  | 'listings'
  | 'applications'
  | 'activity'
  | 'documents'
  | 'files';
export type ReadModelCursor = {
  kind: ReadModelCursorKind;
  id: string;
  value: string | number;
};

export function encodeReadModelCursor(cursor: ReadModelCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeReadModelCursor(
  raw: string | undefined,
  kind: ReadModelCursorKind,
): ReadModelCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(raw)) throw new Error();
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error();
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      row['kind'] !== kind ||
      typeof row['id'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        row['id'],
      )
    )
      throw new Error();
    const position = row['value'];
    if (kind === 'listings') {
      if (
        typeof position !== 'number' ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > 2147483647
      )
        throw new Error();
    } else if (
      typeof position !== 'string' ||
      Number.isNaN(Date.parse(position)) ||
      new Date(position).toISOString() !== position
    )
      throw new Error();
    return { kind, id: row['id'], value: position };
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
