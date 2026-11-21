import type { Article } from '../../database/entities/article.entity';
import {
  mapProfile,
  type PublicProfileUser,
} from '../../profiles/mappers/profile-response.mapper';
import type { ArticleDto } from '../dto/article-response.dto';
import type { ArticleSummaryDto } from '../dto/articles-response.dto';

export type LoadedArticle = Pick<
  Article,
  'slug' | 'title' | 'description' | 'body' | 'createdAt' | 'updatedAt'
> & { author: PublicProfileUser };

export interface ArticleMetadata {
  tagList: string[];
  favoritesCount: number;
  favorited: boolean;
  following: boolean;
}

// Pure allowlist mapper, reusable for future collections without database access.
export function mapArticle(
  article: LoadedArticle,
  metadata: ArticleMetadata,
): ArticleDto {
  return Object.assign(mapArticleSummary(article, metadata), {
    body: article.body,
  });
}

export function mapArticleSummary(
  article: Omit<LoadedArticle, 'body'>,
  metadata: ArticleMetadata,
): ArticleSummaryDto {
  return {
    slug: article.slug,
    title: article.title,
    description: article.description,
    tagList: [...metadata.tagList],
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    favorited: metadata.favorited,
    favoritesCount: metadata.favoritesCount,
    author: mapProfile(article.author, metadata.following),
  };
}
