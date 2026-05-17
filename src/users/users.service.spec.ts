import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Role, UserStatus } from '../generated/prisma/enums';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const makeUser = (): User => ({
  id: 'cuid-abc123',
  name: 'Max Mustermann',
  email: 'max@example.com',
  passwordHash: '$2b$12$somehash',
  role: Role.APPLICANT,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('toSafeUser', () => {
    it('returns all non-sensitive fields', () => {
      const user = makeUser();
      const result = service.toSafeUser(user);

      expect(result.id).toBe(user.id);
      expect(result.name).toBe(user.name);
      expect(result.email).toBe(user.email);
      expect(result.role).toBe(user.role);
      expect(result.emailVerified).toBe(user.emailVerified);
      expect(result.status).toBe(user.status);
      expect(result.acceptedTermsAt).toBe(user.acceptedTermsAt);
      expect(result.acceptedPrivacyAt).toBe(user.acceptedPrivacyAt);
      expect(result.createdAt).toBe(user.createdAt);
      expect(result.updatedAt).toBe(user.updatedAt);
    });

    it('does not expose passwordHash', () => {
      const user = makeUser();
      const result = service.toSafeUser(user);

      expect(result).not.toHaveProperty('passwordHash');
    });

    it('returns exactly the expected SafeUser shape', () => {
      const user = makeUser();
      const result = service.toSafeUser(user);
      const keys = Object.keys(result).sort();

      expect(keys).toEqual(
        [
          'id',
          'name',
          'email',
          'role',
          'emailVerified',
          'status',
          'acceptedTermsAt',
          'acceptedPrivacyAt',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
    });
  });
});
