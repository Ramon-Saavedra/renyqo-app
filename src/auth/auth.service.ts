import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { EnvironmentVariables } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { ProviderType, Role } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { UsersService } from '../users/users.service';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import { PublicProviderType, PublicRole } from './dto/register.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordResetTokensRepository } from './password-reset-tokens.repository';

const SALT_ROUNDS = 12;
const PASSWORD_RESET_TOKEN_BYTES = 32;
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 60;
const PASSWORD_RESET_RESPONSE = {
  message:
    'If an account exists for this email, password reset instructions will be sent.',
};
const PASSWORD_RESET_SUCCESS_RESPONSE = {
  message: 'Password has been reset.',
};
const DUMMY_HASH =
  '$2b$12$invalidhashforuserthatdoesnotexistXXXXXXXXXXXXXXXXXXXX';

const PUBLIC_ROLE_TO_ROLE: Record<PublicRole, Role> = {
  [PublicRole.APPLICANT]: Role.APPLICANT,
  [PublicRole.PROVIDER]: Role.PROVIDER,
};

type ProviderIdentity = {
  providerType: ProviderType | null;
  companyName: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  async register(dto: RegisterDto): Promise<SafeUser> {
    const email = dto.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const providerIdentity = this.getProviderIdentity(dto);
    try {
      return await this.usersService.create({
        name: dto.name,
        email,
        passwordHash,
        role: PUBLIC_ROLE_TO_ROLE[dto.role],
        providerType: providerIdentity.providerType,
        companyName: providerIdentity.companyName,
        acceptedTermsAt: new Date(),
        acceptedPrivacyAt: new Date(),
      });
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  async login(email: string, password: string): Promise<SafeUser> {
    const user = await this.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      return PASSWORD_RESET_RESPONSE;
    }

    const token = this.generateResetToken();
    const tokenHash = this.hashResetToken(token);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    await this.passwordResetTokensRepository.invalidateActiveTokensForUser(
      user.id,
      now,
    );
    await this.passwordResetTokensRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    try {
      await this.emailService.sendPasswordResetEmail({
        to: user.email,
        resetUrl: this.buildResetUrl(token),
      });
    } catch {
      return PASSWORD_RESET_RESPONSE;
    }

    return PASSWORD_RESET_RESPONSE;
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = this.hashResetToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const consumed =
      await this.passwordResetTokensRepository.consumeValidTokenAndUpdatePassword(
        {
          tokenHash,
          passwordHash,
          now: new Date(),
        },
      );

    if (!consumed) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    return PASSWORD_RESET_SUCCESS_RESPONSE;
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<SafeUser | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.usersService.findByEmail(normalizedEmail);
    const hash = user ? user.passwordHash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid) return null;
    return this.usersService.toSafeUser(user);
  }

  private getProviderIdentity(dto: RegisterDto): ProviderIdentity {
    if (dto.role !== PublicRole.PROVIDER) {
      return { providerType: null, companyName: null };
    }

    if (dto.providerType === PublicProviderType.COMPANY) {
      const companyName = dto.companyName?.trim();

      if (!companyName) {
        throw new BadRequestException('Company name is required');
      }

      return { providerType: ProviderType.COMPANY, companyName };
    }

    if (dto.providerType === PublicProviderType.PRIVATE) {
      return { providerType: ProviderType.PRIVATE, companyName: null };
    }

    return { providerType: null, companyName: null };
  }

  private generateResetToken(): string {
    return randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
  }

  private hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private buildResetUrl(token: string): string {
    const frontendUrl =
      this.configService.get('FRONTEND_URL', { infer: true }) ??
      'http://localhost:3001';
    const url = new URL('/reset-password', frontendUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }
}
