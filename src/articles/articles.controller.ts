import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
}
