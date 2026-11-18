import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { EmailModule } from '../email/email.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetTokensRepository } from './password-reset-tokens.repository';
import { SessionSerializer } from './serializers/session.serializer';
import { AuthRevocationService } from './session/auth-revocation.service';
import { SessionModule } from './session/session.module';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { EmailVerificationService } from './email-verification/email-verification.service';
import { EmailVerificationController } from './email-verification/email-verification.controller';
import { SecurityLinkPolicy } from '../security/security-link-policy';
import { SecurityLinkTrafficGuard } from '../security/security-link-traffic.guard';

@Module({
  imports: [
    ProviderAuthorizationModule,
    PassportModule.register({ session: true }),
    UsersModule,
    EmailModule,
    RealtimeModule,
    SessionModule,
  ],
  providers: [
    EmailVerificationService,
    SecurityLinkPolicy,
    SecurityLinkTrafficGuard,
    AuthService,
    SessionSerializer,
    PasswordResetTokensRepository,
    AuthRevocationService,
  ],
  controllers: [AuthController, EmailVerificationController],
})
export class AuthModule {}
