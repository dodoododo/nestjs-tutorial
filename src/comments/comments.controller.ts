import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../auth/interfaces/authenticated-request.interface';
import { CommentsService } from './comments.service';
import { CommentResponseDto } from './dto/comment-response.dto';
import { CreateCommentRequestDto } from './dto/create-comment.dto';
import { CommentsResponseDto } from './dto/comments-response.dto';

@ApiTags('Comments')
@Controller('articles/:slug/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete your own comment',
    description:
      'Returns 204 with no body. Article ownership does not grant Comment deletion rights. Repeated or cross-article deletion returns 404.',
  })
  @ApiParam({ name: 'slug', description: 'Current article slug', type: String })
  @ApiParam({
    name: 'id',
    description: 'Comment UUID',
    type: String,
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Comment deleted' })
  @ApiBadRequestResponse({ description: 'Malformed Comment UUID' })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, expired or revoked JWT',
  })
  @ApiForbiddenResponse({
    description: 'Only the Comment author may delete it',
  })
  @ApiNotFoundResponse({
    description:
      'Article or Comment not found in this Article, including repeated deletion',
  })
  @ApiServiceUnavailableResponse({
    description: 'JWT revocation check unavailable',
  })
  @ApiInternalServerErrorResponse({
    description: 'Unable to delete the comment',
  })
  delete(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<void> {
    return this.comments.deleteComment(slug, id, principal.user.id);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get comments from an article',
    description:
      'Anonymous access is allowed. Supplied credentials must be valid. Ordered by createdAt DESC, id DESC; no pagination.',
    security: [{}, { bearer: [] }],
  })
  @ApiParam({ name: 'slug', description: 'Current article slug', type: String })
  @ApiOkResponse({ type: CommentsResponseDto })
  @ApiNotFoundResponse({ description: 'Article not found' })
  @ApiUnauthorizedResponse({
    description: 'Supplied JWT is malformed, invalid, expired or revoked',
  })
  @ApiServiceUnavailableResponse({
    description: 'JWT revocation check unavailable for supplied credentials',
  })
  @ApiInternalServerErrorResponse({
    description: 'Unable to retrieve comments',
  })
  get(
    @Param('slug') slug: string,
    @CurrentUser() principal: AuthenticatedPrincipal | undefined,
  ): Promise<CommentsResponseDto> {
    return this.comments.getComments(slug, principal?.user.id);
  }

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
  @ApiPayloadTooLargeResponse({
    description: 'JSON request exceeds the 400 KiB transport limit',
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
