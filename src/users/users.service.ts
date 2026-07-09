import { Injectable } from '@nestjs/common';
import type { User, Prisma } from '../generated/prisma/client';
import { ProviderType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { SafeProviderType } from './types/safe-user.type';
import type { SafeUser } from './types/safe-user.type';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.toSafeUser(user) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(data: Prisma.UserCreateInput): Promise<SafeUser> {
    const user = await this.prisma.user.create({ data });
    return this.toSafeUser(user);
  }

  toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      providerType: this.toSafeProviderType(user.providerType),
      companyName:
        user.providerType === ProviderType.COMPANY ? user.companyName : null,
      emailVerified: user.emailVerified,
      status: user.status,
      acceptedTermsAt: user.acceptedTermsAt,
      acceptedPrivacyAt: user.acceptedPrivacyAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private toSafeProviderType(
    providerType: ProviderType | null,
  ): SafeProviderType | null {
    if (providerType === ProviderType.PRIVATE) {
      return 'private';
    }

    if (providerType === ProviderType.COMPANY) {
      return 'company';
    }

    return null;
  }
}
