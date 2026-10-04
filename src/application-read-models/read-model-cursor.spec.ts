import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
  type ReadModelCursorKind,
} from './read-model-cursor';
import { ReadModelPageQueryDto } from './dto/read-model-input.dto';

const id = '12345678-1234-4234-8234-123456789abc';

describe('Read model cursors and input validation', () => {
  it.each([
    'listings',
    'applications',
    'activity',
    'documents',
    'files',
  ] as ReadModelCursorKind[])('round-trips a typed %s cursor', (kind) => {
    const cursor = {
      kind,
      id,
      value: kind === 'listings' ? 2 : '2027-01-01T10:00:00.000Z',
    };
    expect(decodeReadModelCursor(encodeReadModelCursor(cursor), kind)).toEqual(
      cursor,
    );
  });

  it('omits the boundary when no cursor is supplied', () => {
    expect(decodeReadModelCursor(undefined, 'activity')).toBeUndefined();
  });

  it.each([
    '',
    '%%%%',
    'invalid',
    Buffer.from('null').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
    Buffer.from('{"kind":"activity"}').toString('base64url'),
  ])('rejects malformed cursor %s', (raw) => {
    expect(() => decodeReadModelCursor(raw, 'activity')).toThrow(
      BadRequestException,
    );
  });

  it.each([
    { kind: 'files', id, value: '2027-01-01T10:00:00.000Z' },
    { kind: 'activity', id: 'invalid', value: '2027-01-01T10:00:00.000Z' },
    { kind: 'activity', id, value: 'invalid' },
    { kind: 'activity', id, value: '2027-01-01' },
    { kind: 'activity', id, value: '2027-01-01T10:00:00.000Z', extra: true },
  ])('rejects wrong kind, ID, timestamp and extra cursor fields', (cursor) => {
    expect(() =>
      decodeReadModelCursor(
        Buffer.from(JSON.stringify(cursor)).toString('base64url'),
        'activity',
      ),
    ).toThrow(BadRequestException);
  });

  it.each([-1, 1.5, 2147483648, '2'])(
    'rejects invalid listing order %s',
    (value) => {
      expect(() =>
        decodeReadModelCursor(
          Buffer.from(JSON.stringify({ kind: 'listings', id, value })).toString(
            'base64url',
          ),
          'listings',
        ),
      ).toThrow(BadRequestException);
    },
  );

  it('defaults the page size to twenty and accepts the maximum of one hundred', () => {
    expect(new ReadModelPageQueryDto().limit).toBe(20);
    expect(
      validateSync(plainToInstance(ReadModelPageQueryDto, { limit: '100' })),
    ).toEqual([]);
  });

  it.each([0, 101, 1.5, 'invalid'])('rejects page size %s', (limit) => {
    expect(
      validateSync(plainToInstance(ReadModelPageQueryDto, { limit })),
    ).not.toHaveLength(0);
  });
});
