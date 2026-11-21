import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../auth/interfaces/authenticated-request.interface';
import { ArticlesService } from './articles.service';
import { ArticleResponseDto } from './dto/article-response.dto';
import { CreateArticleRequestDto } from './dto/create-article.dto';
import { UpdateArticleRequestDto } from './dto/update-article.dto';

@ApiTags('Articles')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid, expired or revoked JWT',
})
@ApiServiceUnavailableResponse({
  description: 'JWT revocation check unavailable',
})
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create an article' })
  @ApiCreatedResponse({ type: ArticleResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid article input or unknown fields',
  })
  @ApiConflictResponse({
    description: 'An equivalent article slug already exists',
  })
  create(
    @Body() body: CreateArticleRequestDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<ArticleResponseDto> {
    return this.articles.createArticle(body.article, principal.user.id);
  }

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Get an article',
    description:
      'Anonymous access is allowed. Supplied credentials must be valid.',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: ArticleResponseDto })
  @ApiNotFoundResponse({ description: 'Article not found' })
  get(
    @Param('slug') slug: string,
    @CurrentUser() principal: AuthenticatedPrincipal | undefined,
  ): Promise<ArticleResponseDto> {
    return this.articles.getArticle(slug, principal?.user.id);
  }

  @Put(':slug')
  @UseGuards(JwtAuthGuard)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update an article owned by the current user',
    description:
      'Omitted fields are preserved. An empty article object is a no-op. Changing the title regenerates the slug. Tag updates are not accepted.',
  })
  @ApiOkResponse({ type: ArticleResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid article input or unknown fields',
  })
  @ApiForbiddenResponse({
    description: 'Only the article author may update it',
  })
  @ApiNotFoundResponse({ description: 'Article not found' })
  @ApiConflictResponse({
    description: 'An equivalent article slug already exists',
  })
  update(
    @Param('slug') slug: string,
    @Body() body: UpdateArticleRequestDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<ArticleResponseDto> {
    return this.articles.updateArticle(slug, body.article, principal.user.id);
  }

  @Delete(':slug')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete an article owned by the current user',
    description: 'Returns 204 with no body. A repeated deletion returns 404.',
  })
  @ApiNoContentResponse({ description: 'Article deleted' })
  @ApiForbiddenResponse({
    description: 'Only the article author may delete it',
  })
  @ApiNotFoundResponse({ description: 'Article not found' })
  delete(
    @Param('slug') slug: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<void> {
    return this.articles.deleteArticle(slug, principal.user.id);
  }
}
