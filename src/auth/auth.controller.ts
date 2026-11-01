import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthenticatedGuard } from './guards/authenticated.guard';
import { RealtimeConnectionsService } from '../realtime/realtime-connections.service';
import { SessionInfrastructureService } from './session/session-infrastructure.service';
import {
  generateCsrfToken,
  revokeCsrfToken,
} from '../security/csrf/csrf-protection';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(
    private readonly authService: AuthService,
    private readonly realtimeConnections: RealtimeConnectionsService,
    private readonly sessions: SessionInfrastructureService,
  ) {}

  @Get('csrf-token')
  csrfToken(@Req() req: Request): { csrfToken: string } {
    return { csrfToken: generateCsrfToken(req) };
  }

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<SafeUser> {
    const user = await this.authService.register(dto);
    await this.establishSession(req, user);
    return user;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<SafeUser> {
    const user = await this.authService.login(dto.email, dto.password);
    await this.establishSession(req, user);
    return user;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.resetPassword(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const sessionId = req.sessionID;
    await this.sessions.revokeGrant(sessionId);
    revokeCsrfToken(req);
    await this.destroySessionBestEffort(req);
    res.clearCookie('sid');
    // Avoid Passport's save/regenerate sequence: destroy precisely the original SID.
    delete req.user;
    try {
      this.realtimeConnections.disconnectSessions([sessionId]);
    } catch {
      this.logger.warn({ signal: 'AUTH_REALTIME_CLEANUP_FAILED' });
    }
    return { message: 'Logged out' };
  }

  private async establishSession(req: Request, user: SafeUser): Promise<void> {
    try {
      await this.regenerateSession(req);
      await new Promise<void>((resolve, reject) => {
        req.login(user, (error: unknown) =>
          error
            ? reject(
                error instanceof Error
                  ? error
                  : new Error('Session creation failed'),
              )
            : resolve(),
        );
      });
      await this.sessions.establishGrant(req.sessionID, user);
    } catch (error) {
      // Also handle an ambiguous grant-write outcome. Never send a usable session on failure.
      try {
        await this.sessions.revokeGrant(req.sessionID);
      } catch {
        this.logger.warn({ signal: 'AUTH_GRANT_CLEANUP_FAILED' });
      }
      await this.destroySessionBestEffort(req);
      delete req.user;
      throw error;
    }
  }

  private async destroySessionBestEffort(req: Request): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.destroy((error: unknown) =>
          error
            ? reject(
                error instanceof Error
                  ? error
                  : new Error('Session destruction failed'),
              )
            : resolve(),
        );
      });
    } catch {
      this.logger.warn({ signal: 'AUTH_SESSION_CLEANUP_FAILED' });
    } finally {
      Reflect.deleteProperty(req, 'session');
    }
  }

  @UseGuards(AuthenticatedGuard)
  @Get('me')
  me(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }

  private async regenerateSession(req: Request): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
