import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';

import { Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PublicRole } from './dto/register.dto';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const makeSafeUser = (): SafeUser => ({
  id: USER_ID,
  name: 'Test User',
  email: 'test@example.com',
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

const makeRegisterDto = () => ({
  name: 'Test User',
  email: 'test@example.com',
  password: 'password123',
  role: PublicRole.APPLICANT,
  acceptedTerms: true as const,
  acceptedPrivacy: true as const,
});

const makeLoginDto = (): LoginDto => ({
  email: 'test@example.com',
  password: 'password123',
});

type MockRequest = {
  login: jest.MockedFunction<
    (user: unknown, cb: (err?: unknown) => void) => void
  >;
};

const makeReq = (loginError?: Error): MockRequest => ({
  login: jest.fn((_user: unknown, cb: (err?: unknown) => void) => {
    cb(loginError);
  }),
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<Pick<AuthService, 'register' | 'login'>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: jest.fn(),
            login: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
  });

  describe('register', () => {
    it('calls req.login with the created user', async () => {
      const user = makeSafeUser();
      authService.register.mockResolvedValue(user);
      const req = makeReq();

      await controller.register(makeRegisterDto(), req as unknown as Request);

      expect(req.login).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('returns the safe user after registration', async () => {
      const user = makeSafeUser();
      authService.register.mockResolvedValue(user);
      const req = makeReq();

      const result = await controller.register(
        makeRegisterDto(),
        req as unknown as Request,
      );

      expect(result).toEqual(user);
    });

    it('does not return passwordHash', async () => {
      const user = makeSafeUser();
      authService.register.mockResolvedValue(user);
      const req = makeReq();

      const result = await controller.register(
        makeRegisterDto(),
        req as unknown as Request,
      );

      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws if session creation fails', async () => {
      const user = makeSafeUser();
      authService.register.mockResolvedValue(user);
      const req = makeReq(new Error('Session store failed'));

      await expect(
        controller.register(makeRegisterDto(), req as unknown as Request),
      ).rejects.toThrow('Session store failed');
    });
  });

  describe('login', () => {
    it('calls authService.login with email and password from dto', async () => {
      const user = makeSafeUser();
      authService.login.mockResolvedValue(user);
      const req = makeReq();

      await controller.login(makeLoginDto(), req as unknown as Request);

      expect(authService.login).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
      );
    });

    it('calls req.login with the authenticated user', async () => {
      const user = makeSafeUser();
      authService.login.mockResolvedValue(user);
      const req = makeReq();

      await controller.login(makeLoginDto(), req as unknown as Request);

      expect(req.login).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('returns the safe user after login', async () => {
      const user = makeSafeUser();
      authService.login.mockResolvedValue(user);
      const req = makeReq();

      const result = await controller.login(
        makeLoginDto(),
        req as unknown as Request,
      );

      expect(result).toEqual(user);
    });

    it('does not return passwordHash', async () => {
      const user = makeSafeUser();
      authService.login.mockResolvedValue(user);
      const req = makeReq();

      const result = await controller.login(
        makeLoginDto(),
        req as unknown as Request,
      );

      expect(result).not.toHaveProperty('passwordHash');
    });

    it('throws UnauthorizedException when authService.login rejects', async () => {
      authService.login.mockRejectedValue(
        new UnauthorizedException('Invalid credentials'),
      );
      const req = makeReq();

      await expect(
        controller.login(makeLoginDto(), req as unknown as Request),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws if session creation fails after login', async () => {
      const user = makeSafeUser();
      authService.login.mockResolvedValue(user);
      const req = makeReq(new Error('Session store failed'));

      await expect(
        controller.login(makeLoginDto(), req as unknown as Request),
      ).rejects.toThrow('Session store failed');
    });
  });
});
