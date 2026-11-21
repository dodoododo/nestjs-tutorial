import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { DataSource, QueryFailedError } from 'typeorm';
import { Article } from '../database/entities/article.entity';
import { Comment } from '../database/entities/comment.entity';
import { User } from '../database/entities/user.entity';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { mapComment } from './mappers/comment-response.mapper';

function isArticleForeignKeyFailure(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: string; message?: string };
  return (
    driver.code === 'ER_NO_REFERENCED_ROW_2' &&
    /CONSTRAINT [`']FK_comments_article_id[`']/i.test(driver.message ?? '')
  );
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly i18n: I18nService,
  ) {}

  async createComment(
    slug: string,
    dto: CreateCommentDto,
    authorId: string,
  ): Promise<CommentResponseDto> {
    const manager = this.dataSource.manager;
    try {
      const article = await manager.findOne(Article, {
        where: { slug },
        select: { id: true },
      });
      if (!article)
        throw new NotFoundException(this.i18n.t('comments.ARTICLE_NOT_FOUND'));
      const author = await manager.findOne(User, {
        where: { id: authorId },
        select: { username: true, bio: true, image: true },
      });
      if (!author) throw new UnauthorizedException();

      let saved: Comment;
      try {
        // One atomic INSERT; TypeORM generates the UUID and reloads database
        // timestamps. No transaction, article update or client-owned fields.
        saved = await manager.save(
          Comment,
          {
            articleId: article.id,
            authorId,
            body: dto.body,
          },
          { transaction: false },
        );
      } catch (error: unknown) {
        if (
          isArticleForeignKeyFailure(error) &&
          !(await manager.existsBy(Article, { id: article.id }))
        ) {
          throw new NotFoundException(
            this.i18n.t('comments.ARTICLE_NOT_FOUND'),
          );
        }
        throw error;
      }
      // Self-follow is prohibited, so the creating viewer cannot follow themself.
      return { comment: mapComment(saved, author, { following: false }) };
    } catch (error: unknown) {
      if (
        error instanceof NotFoundException ||
        error instanceof UnauthorizedException
      )
        throw error;
      // Keep the original diagnostic cause on the exception, but never log SQL,
      // query parameters, request bodies, tokens or untrusted error messages.
      const code =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: unknown }).code
          : undefined;
      this.logger.error('Comment creation failed', {
        errorType:
          error instanceof QueryFailedError ? 'QueryFailedError' : 'Error',
        code:
          typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
            ? code
            : undefined,
      });
      throw new InternalServerErrorException(
        this.i18n.t('comments.PERSISTENCE_FAILED'),
        { cause: error },
      );
    }
  }
}
