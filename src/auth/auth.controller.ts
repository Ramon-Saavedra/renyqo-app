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
import type { SafeUser } from '../users/types/safe-user.type';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthenticatedGuard } from './guards/authenticated.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<SafeUser> {
    const user = await this.authService.register(dto);
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

  @UseGuards(AuthenticatedGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    await new Promise<void>((resolve, reject) => {
      req.logout((err: unknown) => {
        if (err)
          reject(err instanceof Error ? err : new Error('Logout failed'));
        else resolve();
      });
    });
    await new Promise<void>((resolve) => {
      req.session.destroy(() => resolve());
    });
    res.clearCookie('sid');
    return { message: 'Logged out' };
  }

  @UseGuards(AuthenticatedGuard)
  @Get('me')
  me(@Req() req: Request): SafeUser {
    return req.user as SafeUser;
  }
}
