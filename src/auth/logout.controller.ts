import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from './interfaces/authenticated-request.interface';
import { LogoutService } from './logout.service';

@ApiTags('Authentication')
@Controller('logout')
export class LogoutController {
  constructor(private readonly logoutService: LogoutService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out and revoke the current JWT',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'JWT revoked successfully',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing, invalid, expired, or revoked JWT',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Token revocation service unavailable',
  })
  async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<void> {
    await this.logoutService.logout(principal.jti, principal.exp);
  }
}
