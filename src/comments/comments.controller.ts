import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../auth/interfaces/authenticated-request.interface';
import { CommentsService } from './comments.service';
import { CommentResponseDto } from './dto/comment-response.dto';
import { CreateCommentRequestDto } from './dto/create-comment.dto';

@ApiTags('Comments')
@Controller('articles/:slug/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a comment to an article' })
  @ApiParam({ name: 'slug', description: 'Current article slug', type: String })
  @ApiBody({ type: CreateCommentRequestDto })
  @ApiCreatedResponse({
    type: CommentResponseDto,
    description: 'Comment created (project convention: HTTP 201)',
  })
  @ApiBadRequestResponse({
    description:
      'Invalid nested input, unknown fields, invalid Unicode or more than 65535 UTF-8 bytes',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, expired or revoked JWT',
  })
  @ApiNotFoundResponse({ description: 'Article not found' })
  @ApiServiceUnavailableResponse({
    description: 'JWT revocation check unavailable',
  })
  @ApiInternalServerErrorResponse({
    description: 'Unable to create the comment',
  })
  create(
    @Param('slug') slug: string,
    @Body() body: CreateCommentRequestDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<CommentResponseDto> {
    return this.comments.createComment(slug, body.comment, principal.user.id);
  }
}
