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
import {
  generateCsrfToken,
  revokeCsrfToken,
} from '../security/csrf/csrf-protection';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
    await this.regenerateSession(req);
    await new Promise<void>((resolve, reject) => {
      req.login(user, (err: unknown) => {
        if (err)
          reject(
            err instanceof Error ? err : new Error('Session creation failed'),
          );
        else resolve();
      });
    });
    return user;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<SafeUser> {
    const user = await this.authService.login(dto.email, dto.password);
    await this.regenerateSession(req);
    await new Promise<void>((resolve, reject) => {
      req.login(user, (err: unknown) => {
        if (err)
          reject(
            err instanceof Error ? err : new Error('Session creation failed'),
          );
        else resolve();
      });
    });
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

  @UseGuards(AuthenticatedGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    revokeCsrfToken(req);
    let logoutError: Error | undefined;
    await new Promise<void>((resolve) => {
      req.logout((err: unknown) => {
        if (err) {
          logoutError = err instanceof Error ? err : new Error('Logout failed');
        }
        resolve();
      });
    });
    let destroyError: Error | undefined;
    await new Promise<void>((resolve) => {
      req.session.destroy((err: Error | null) => {
        if (err) destroyError = err;
        resolve();
      });
    });
    res.clearCookie('sid');
    if (logoutError ?? destroyError) {
      throw logoutError ?? destroyError ?? new Error('Logout failed');
    }
    return { message: 'Logged out' };
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
