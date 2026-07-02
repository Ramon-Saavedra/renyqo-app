import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { Role } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { UsersService } from '../users/users.service';
import { PublicRole } from './dto/register.dto';
import type { RegisterDto } from './dto/register.dto';

const SALT_ROUNDS = 12;
const DUMMY_HASH =
  '$2b$12$invalidhashforuserthatdoesnotexistXXXXXXXXXXXXXXXXXXXX';

const PUBLIC_ROLE_TO_ROLE: Record<PublicRole, Role> = {
  [PublicRole.APPLICANT]: Role.APPLICANT,
  [PublicRole.PROVIDER]: Role.PROVIDER,
};

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  async register(dto: RegisterDto): Promise<SafeUser> {
    const email = dto.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    try {
      return await this.usersService.create({
        name: dto.name,
        email,
        passwordHash,
        role: PUBLIC_ROLE_TO_ROLE[dto.role],
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
}
