import {
  Injectable,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { Article } from '../database/entities/article.entity';
import { Comment } from '../database/entities/comment.entity';
import { User } from '../database/entities/user.entity';
import { Follow } from '../database/entities/follow.entity';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { CommentsResponseDto } from './dto/comments-response.dto';
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

  async deleteComment(
    slug: string,
    id: string,
    currentUserId: string,
  ): Promise<void> {
    const manager = this.dataSource.manager;
    try {
      const article = await manager.findOne(Article, {
        where: { slug },
        select: { id: true },
      });
      if (!article)
        throw new NotFoundException(this.i18n.t('comments.ARTICLE_NOT_FOUND'));
      // Resolve membership before ownership; unrelated IDs always yield 404.
      const comment = await manager.findOne(Comment, {
        where: { id, articleId: article.id },
        select: { id: true, authorId: true },
      });
      if (!comment)
        throw new NotFoundException(this.i18n.t('comments.NOT_FOUND'));
      if (comment.authorId !== currentUserId)
        throw new ForbiddenException(this.i18n.t('comments.NOT_AUTHOR'));
      const result = await manager.delete(Comment, {
        id: comment.id,
        articleId: article.id,
        authorId: currentUserId,
      });
      if (result.affected !== 1)
        throw new NotFoundException(this.i18n.t('comments.NOT_FOUND'));
    } catch (error: unknown) {
      this.handlePersistenceError(error, 'deletion');
    }
  }

  async getComments(
    slug: string,
    viewerId?: string,
  ): Promise<CommentsResponseDto> {
    const manager = this.dataSource.manager;
    try {
      const article = await manager.findOne(Article, {
        where: { slug },
        select: { id: true },
      });
      if (!article)
        throw new NotFoundException(this.i18n.t('comments.ARTICLE_NOT_FOUND'));
      const comments = await manager
        .createQueryBuilder(Comment, 'comment')
        .innerJoin('comment.author', 'author')
        .select([
          'comment.id',
          'comment.body',
          'comment.createdAt',
          'comment.updatedAt',
          'author.id',
          'author.username',
          'author.bio',
          'author.image',
        ])
        .where('comment.articleId = :articleId', { articleId: article.id })
        .orderBy('comment.createdAt', 'DESC')
        .addOrderBy('comment.id', 'DESC')
        .getMany();
      if (!comments.length) return { comments: [] };

      const followingIds = new Set<string>();
      if (viewerId !== undefined) {
        const authorIds = [
          ...new Set(comments.map((comment) => comment.author.id)),
        ];
        const follows = await manager.find(Follow, {
          where: { followerId: viewerId, followingId: In(authorIds) },
          select: { followingId: true },
        });
        for (const follow of follows) followingIds.add(follow.followingId);
      }
      return {
        comments: comments.map((comment) =>
          mapComment(comment, comment.author, {
            following: followingIds.has(comment.author.id),
          }),
        ),
      };
    } catch (error: unknown) {
      this.handlePersistenceError(error, 'retrieval');
    }
  }

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
      this.handlePersistenceError(error, 'creation');
    }
  }

  private handlePersistenceError(
    error: unknown,
    operation: 'creation' | 'retrieval' | 'deletion',
  ): never {
    if (
      error instanceof NotFoundException ||
      error instanceof ForbiddenException ||
      error instanceof UnauthorizedException
    )
      throw error;
    // Keep the original diagnostic cause on the exception, but never log SQL,
    // query parameters, request bodies, tokens or untrusted error messages.
    const code =
      error instanceof QueryFailedError
        ? (error.driverError as { code?: unknown }).code
        : undefined;
    this.logger.error(`Comment ${operation} failed`, {
      errorType:
        error instanceof QueryFailedError ? 'QueryFailedError' : 'Error',
      code:
        typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
          ? code
          : undefined,
    });
    throw new InternalServerErrorException(
      this.i18n.t(
        {
          creation: 'comments.PERSISTENCE_FAILED',
          retrieval: 'comments.RETRIEVAL_FAILED',
          deletion: 'comments.DELETION_FAILED',
        }[operation],
      ),
      { cause: error },
    );
  }
}
