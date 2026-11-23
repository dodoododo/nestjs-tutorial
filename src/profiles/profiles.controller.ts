import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../auth/interfaces/authenticated-request.interface';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { ProfilesService } from './profiles.service';

@ApiTags('Profiles')
@ApiParam({ name: 'username', description: 'Username of the target profile' })
@ApiOkResponse({ type: ProfileResponseDto })
@ApiNotFoundResponse({ description: 'Profile does not exist' })
@ApiUnauthorizedResponse({ description: 'Invalid, expired, or revoked JWT' })
@ApiServiceUnavailableResponse({
  description: 'JWT revocation check unavailable',
})
@Controller('profiles/:username')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get a public profile',
    description:
      'Authentication is optional. Supplied credentials must be valid. Anonymous requests return following: false.',
    security: [{}, { bearer: [] }],
  })
  getProfile(
    @Param('username') username: string,
    @CurrentUser() principal: AuthenticatedPrincipal | undefined,
  ): Promise<ProfileResponseDto> {
    return this.profilesService.getProfile(username, principal?.user.id);
  }

  @Post('follow')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Follow a user',
    description:
      'Idempotent: returns 200 with following: true even if the relationship already exists.',
  })
  @ApiBadRequestResponse({ description: 'Cannot follow yourself' })
  follow(
    @Param('username') username: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<ProfileResponseDto> {
    return this.profilesService.follow(username, principal.user.id);
  }

  @Delete('follow')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Unfollow a user',
    description:
      'Idempotent: returns 200 with following: false even if the relationship does not exist.',
  })
  unfollow(
    @Param('username') username: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<ProfileResponseDto> {
    return this.profilesService.unfollow(username, principal.user.id);
  }
}
