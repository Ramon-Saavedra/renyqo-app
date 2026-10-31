import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

import { Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { RealtimeConnectionsService } from '../realtime/realtime-connections.service';
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
  session: {
    regenerate: jest.MockedFunction<(cb: (err: Error | null) => void) => void>;
  };
  login: jest.MockedFunction<
    (user: unknown, cb: (err?: unknown) => void) => void
  >;
};

const makeReq = (loginError?: Error): MockRequest => ({
  session: {
    regenerate: jest.fn((cb: (err: Error | null) => void) => {
      cb(loginError ?? null);
    }),
  },
  login: jest.fn((_user: unknown, cb: (err?: unknown) => void) => {
    cb(loginError);
  }),
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<
    Pick<AuthService, 'register' | 'login' | 'forgotPassword' | 'resetPassword'>
  >;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: jest.fn(),
            login: jest.fn(),
            forgotPassword: jest.fn(),
            resetPassword: jest.fn(),
          },
        },
        {
          provide: RealtimeConnectionsService,
          useValue: {
            disconnectSessions: jest.fn(),
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

  describe('logout', () => {
    function logoutRequest(error?: Error) {
      const destroy = jest.fn((callback: (error: Error | null) => void) =>
        callback(error ?? null),
      );
      const req = {
        sessionID: 'original-sid',
        session: { destroy },
        user: makeSafeUser(),
        logout: jest.fn(),
      };
      const res = { clearCookie: jest.fn() };
      return { req, res, destroy };
    }
    it('destroys precisely the current session without Passport save/regenerate or global revocation', async () => {
      const { req, res, destroy } = logoutRequest();
      await expect(
        controller.logout(
          req as unknown as Request,
          res as unknown as Response,
        ),
      ).resolves.toEqual({ message: 'Logged out' });
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(req.logout).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(res.clearCookie).toHaveBeenCalledWith('sid');
    });
    it('does not report success when durable destruction fails', async () => {
      const { req, res } = logoutRequest(new Error('store failed'));
      await expect(
        controller.logout(
          req as unknown as Request,
          res as unknown as Response,
        ),
      ).rejects.toThrow('store failed');
    });
    it('allows repeated unauthenticated logout', async () => {
      const { req, res } = logoutRequest();
      delete (req as { user?: SafeUser }).user;
      await controller.logout(
        req as unknown as Request,
        res as unknown as Response,
      );
      await expect(
        controller.logout(
          req as unknown as Request,
          res as unknown as Response,
        ),
      ).resolves.toEqual({ message: 'Logged out' });
    });
  });

  describe('forgotPassword', () => {
    it('passes the dto to authService and returns its neutral response', async () => {
      authService.forgotPassword.mockResolvedValue({
        message:
          'If an account exists for this email, password reset instructions will be sent.',
      });

      const result = await controller.forgotPassword({
        email: 'test@example.com',
      });

      expect(authService.forgotPassword).toHaveBeenCalledWith({
        email: 'test@example.com',
      });
      expect(result).toEqual({
        message:
          'If an account exists for this email, password reset instructions will be sent.',
      });
    });
  });

  describe('resetPassword', () => {
    it('passes the dto to authService and returns success response', async () => {
      authService.resetPassword.mockResolvedValue({
        message: 'Password has been reset.',
      });

      const result = await controller.resetPassword({
        token: 'token',
        password: 'newpassword123',
      });

      expect(authService.resetPassword).toHaveBeenCalledWith({
        token: 'token',
        password: 'newpassword123',
      });
      expect(result).toEqual({ message: 'Password has been reset.' });
    });
  });
});
