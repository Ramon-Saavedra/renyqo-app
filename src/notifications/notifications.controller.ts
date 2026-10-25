import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { NotificationService } from './notification.service';
import {
  NotificationParamsDto,
  NotificationQueryDto,
  NotificationReadAllDto,
} from './notification.dto';

@Controller('me/notifications')
@UseGuards(AuthenticatedGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationService) {}
  @Get() list(
    @CurrentUser() user: SafeUser,
    @Query() query: NotificationQueryDto,
  ) {
    return this.service.list(user.id, query);
  }
  @Get('unread-count') unread(@CurrentUser() user: SafeUser) {
    return this.service.unread(user.id);
  }
  @Post('read-all')
  @HttpCode(200)
  all(@CurrentUser() user: SafeUser, @Body() body: NotificationReadAllDto) {
    return this.service.markAllRead(user.id, new Date(body.throughCreatedAt));
  }
  @Post(':notificationId/read')
  @HttpCode(200)
  read(@CurrentUser() user: SafeUser, @Param() params: NotificationParamsDto) {
    return this.service.markRead(user.id, params.notificationId);
  }
}
