import {
  Controller,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserResponseDto } from '../auth/dto/user-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../auth/interfaces/authenticated-request.interface';
import { AVATAR_MULTIPART_FILE_LIMIT } from './avatar.constants';
import { AvatarsService } from './avatars.service';

@ApiTags('Avatars')
@Controller('users/avatar')
export class AvatarsController {
  constructor(private readonly avatarsService: AvatarsService) {}

  @Put()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      limits: {
        fileSize: AVATAR_MULTIPART_FILE_LIMIT,
        files: 1,
        fields: 0,
        parts: 2,
        fieldNameSize: 64,
      },
    }),
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Replace your public avatar (JPEG, PNG or WebP, at most 5 MiB)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      additionalProperties: false,
      properties: { avatar: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({
    description:
      'Missing, malformed, mismatched or invalid image; unexpected multipart fields',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, expired or revoked JWT',
  })
  @ApiPayloadTooLargeResponse({ description: 'Avatar exceeds 5 MiB' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Only JPEG, PNG and WebP are allowed',
  })
  @ApiServiceUnavailableResponse({
    description: 'JWT revocation check unavailable',
  })
  upload(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<UserResponseDto> {
    return this.avatarsService.upload(principal.user.id, principal.token, file);
  }
}
