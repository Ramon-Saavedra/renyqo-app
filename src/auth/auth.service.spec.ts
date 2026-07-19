import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { EmailService } from '../email/email.service';
import { ProviderType, Role, UserStatus } from '../generated/prisma/enums';
import type { User } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { PublicProviderType, PublicRole } from './dto/register.dto';
import { PasswordResetTokensRepository } from './password-reset-tokens.repository';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
  getRounds: jest.fn(),
}));

const USER_ID = '00000000-0000-4000-8000-000000000001';

const makeUser = (): User => ({
  id: USER_ID,
  name: 'Test User',
  email: 'test@example.com',
  passwordHash: '$2b$12$somehash',
  role: Role.APPLICANT,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const makeSafeUser = (user: User): SafeUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  providerType:
    user.providerType === ProviderType.COMPANY
      ? 'company'
      : user.providerType === ProviderType.PRIVATE
        ? 'private'
        : null,
  companyName:
    user.providerType === ProviderType.COMPANY ? user.companyName : null,
  emailVerified: user.emailVerified,
  status: user.status,
  acceptedTermsAt: user.acceptedTermsAt,
  acceptedPrivacyAt: user.acceptedPrivacyAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const makeRegisterDto = (
  overrides: Partial<{
    email: string;
    name: string;
    role: PublicRole;
    providerType: PublicProviderType;
    companyName: string;
  }> = {},
) => ({
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
  password: 'password123',
  role: overrides.role ?? PublicRole.APPLICANT,
  providerType: overrides.providerType,
  companyName: overrides.companyName,
  acceptedTerms: true as const,
  acceptedPrivacy: true as const,
});

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let passwordResetTokensRepository: jest.Mocked<PasswordResetTokensRepository>;
  let emailService: jest.Mocked<EmailService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            create: jest.fn(),
            toSafeUser: jest.fn(),
          },
        },
        {
          provide: PasswordResetTokensRepository,
          useValue: {
            invalidateActiveTokensForUser: jest.fn(),
            create: jest.fn(),
            consumeValidTokenAndUpdatePassword: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendPasswordResetEmail: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'FRONTEND_URL' ? 'https://app.renyqo.test' : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get<jest.Mocked<UsersService>>(UsersService);
    passwordResetTokensRepository = module.get<
      jest.Mocked<PasswordResetTokensRepository>
    >(PasswordResetTokensRepository);
    emailService = module.get<jest.Mocked<EmailService>>(EmailService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('normalizes email to lowercase and trims whitespace', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockResolvedValue(safeUser);

      await service.register(
        makeRegisterDto({ email: '  TEST@EXAMPLE.COM  ' }),
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@example.com' }),
      );
    });

    it('hashes the password before creating the user', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed_pw' as never);
      usersService.create.mockResolvedValue(safeUser);

      await service.register(makeRegisterDto());

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'hashed_pw' }),
      );
    });

    it('returns a SafeUser on success', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockResolvedValue(safeUser);

      const result = await service.register(makeRegisterDto());

      expect(result).toEqual(safeUser);
    });

    it('stores private provider identity with null company name', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockResolvedValue(safeUser);

      await service.register(
        makeRegisterDto({
          role: PublicRole.PROVIDER,
          providerType: PublicProviderType.PRIVATE,
          companyName: 'Ignored Company',
        }),
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.PROVIDER,
          providerType: ProviderType.PRIVATE,
          companyName: null,
        }),
      );
    });

    it('stores company provider identity with trimmed company name', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockResolvedValue(safeUser);

      await service.register(
        makeRegisterDto({
          role: PublicRole.PROVIDER,
          providerType: PublicProviderType.COMPANY,
          companyName: '  Kessler Immobilien GbR  ',
        }),
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.PROVIDER,
          providerType: ProviderType.COMPANY,
          companyName: 'Kessler Immobilien GbR',
        }),
      );
    });

    it('throws BadRequestException when company provider has no company name', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);

      await expect(
        service.register(
          makeRegisterDto({
            role: PublicRole.PROVIDER,
            providerType: PublicProviderType.COMPANY,
            companyName: '   ',
          }),
        ),
      ).rejects.toThrow('Company name is required');
    });

    it('does not include passwordHash in the returned user', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockResolvedValue(safeUser);

      const result = await service.register(makeRegisterDto());

      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws ConflictException when email already exists (P2002)', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      const prismaError = new PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '7.0.0' },
      );
      usersService.create.mockRejectedValue(prismaError);

      await expect(service.register(makeRegisterDto())).rejects.toThrow(
        ConflictException,
      );
    });

    it('rethrows non-P2002 errors', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed' as never);
      usersService.create.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.register(makeRegisterDto())).rejects.toThrow(
        'DB connection lost',
      );
    });
  });

  describe('validateUser', () => {
    it('returns null when user does not exist', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const result = await service.validateUser(
        'unknown@example.com',
        'password',
      );

      expect(result).toBeNull();
    });

    it('returns null when password is wrong', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const result = await service.validateUser(
        'test@example.com',
        'wrongpassword',
      );

      expect(result).toBeNull();
    });

    it('returns SafeUser when credentials are valid', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      usersService.findByEmail.mockResolvedValue(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      usersService.toSafeUser.mockReturnValue(safeUser);

      const result = await service.validateUser(
        'test@example.com',
        'correctpassword',
      );

      expect(result).toEqual(safeUser);
    });

    it('normalizes email before lookup', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      await service.validateUser('  TEST@EXAMPLE.COM  ', 'password');

      expect(usersService.findByEmail).toHaveBeenCalledWith('test@example.com');
    });

    it('always calls bcrypt.compare even when user does not exist', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      const compareMock = jest
        .mocked(bcrypt.compare)
        .mockResolvedValue(false as never);

      await service.validateUser('unknown@example.com', 'password');

      expect(compareMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('login', () => {
    it('returns SafeUser when credentials are valid', async () => {
      const user = makeUser();
      const safeUser = makeSafeUser(user);
      usersService.findByEmail.mockResolvedValue(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      usersService.toSafeUser.mockReturnValue(safeUser);

      const result = await service.login('test@example.com', 'correctpassword');

      expect(result).toEqual(safeUser);
    });

    it('throws UnauthorizedException when credentials are invalid', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      await expect(
        service.login('unknown@example.com', 'wrongpassword'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException with generic message', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      await expect(
        service.login('unknown@example.com', 'wrongpassword'),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('forgotPassword', () => {
    it('returns the same neutral response when the user does not exist', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword({
        email: 'unknown@example.com',
      });

      expect(result).toEqual({
        message:
          'If an account exists for this email, password reset instructions will be sent.',
      });
      expect(passwordResetTokensRepository.create).not.toHaveBeenCalled();
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('normalizes email before lookup', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await service.forgotPassword({ email: '  TEST@EXAMPLE.COM  ' });

      expect(usersService.findByEmail).toHaveBeenCalledWith('test@example.com');
    });

    it('invalidates previous active tokens and emails a new reset token', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      passwordResetTokensRepository.invalidateActiveTokensForUser.mockResolvedValue();
      passwordResetTokensRepository.create.mockResolvedValue();
      emailService.sendPasswordResetEmail.mockResolvedValue();

      const result = await service.forgotPassword({
        email: 'test@example.com',
      });

      expect(result).toEqual({
        message:
          'If an account exists for this email, password reset instructions will be sent.',
      });
      expect(
        passwordResetTokensRepository.invalidateActiveTokensForUser,
      ).toHaveBeenCalledWith(user.id, expect.any(Date));
      expect(passwordResetTokensRepository.create).toHaveBeenCalledWith({
        userId: user.id,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
      });
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith({
        to: user.email,
        resetUrl: expect.stringContaining(
          'https://app.renyqo.test/reset-password?token=',
        ),
      });
    });

    it('stores only the token hash, not the raw email token', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      passwordResetTokensRepository.invalidateActiveTokensForUser.mockResolvedValue();
      passwordResetTokensRepository.create.mockResolvedValue();
      emailService.sendPasswordResetEmail.mockResolvedValue();

      await service.forgotPassword({ email: 'test@example.com' });

      const createInput =
        passwordResetTokensRepository.create.mock.calls[0]?.[0];
      const emailInput = emailService.sendPasswordResetEmail.mock.calls[0]?.[0];
      const token = emailInput
        ? new URL(emailInput.resetUrl).searchParams.get('token')
        : null;

      expect(token).toBeTruthy();
      expect(createInput?.tokenHash).not.toBe(token);
      expect(createInput?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps the neutral response if SES delivery fails', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      passwordResetTokensRepository.invalidateActiveTokensForUser.mockResolvedValue();
      passwordResetTokensRepository.create.mockResolvedValue();
      emailService.sendPasswordResetEmail.mockRejectedValue(
        new Error('SES unavailable'),
      );

      const result = await service.forgotPassword({
        email: 'test@example.com',
      });

      expect(result).toEqual({
        message:
          'If an account exists for this email, password reset instructions will be sent.',
      });
    });
  });

  describe('resetPassword', () => {
    it('rejects an invalid token with a clear 400 error', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('new_hash' as never);
      passwordResetTokensRepository.consumeValidTokenAndUpdatePassword.mockResolvedValue(
        false,
      );

      await expect(
        service.resetPassword({
          token: 'invalid-token',
          password: 'newpassword123',
        }),
      ).rejects.toThrow('Invalid or expired reset token');
    });

    it('rejects an expired token through the same safe error path', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('new_hash' as never);
      passwordResetTokensRepository.consumeValidTokenAndUpdatePassword.mockResolvedValue(
        false,
      );

      await expect(
        service.resetPassword({
          token: 'expired-token',
          password: 'newpassword123',
        }),
      ).rejects.toThrow('Invalid or expired reset token');
    });

    it('rejects an already-used token through the same safe error path', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('new_hash' as never);
      passwordResetTokensRepository.consumeValidTokenAndUpdatePassword.mockResolvedValue(
        false,
      );

      await expect(
        service.resetPassword({
          token: 'used-token',
          password: 'newpassword123',
        }),
      ).rejects.toThrow('Invalid or expired reset token');
    });

    it('hashes the new password and consumes the token atomically', async () => {
      jest.mocked(bcrypt.hash).mockResolvedValue('new_password_hash' as never);
      passwordResetTokensRepository.consumeValidTokenAndUpdatePassword.mockResolvedValue(
        true,
      );

      const result = await service.resetPassword({
        token: 'valid-token',
        password: 'newpassword123',
      });

      expect(result).toEqual({ message: 'Password has been reset.' });
      expect(bcrypt.hash).toHaveBeenCalledWith('newpassword123', 12);
      expect(
        passwordResetTokensRepository.consumeValidTokenAndUpdatePassword,
      ).toHaveBeenCalledWith({
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        passwordHash: 'new_password_hash',
        now: expect.any(Date),
      });
    });
  });
});
