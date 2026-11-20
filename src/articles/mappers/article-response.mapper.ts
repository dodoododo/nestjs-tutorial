import type { Article } from '../../database/entities/article.entity';
import type { User } from '../../database/entities/user.entity';
import type { ArticleDto } from '../dto/article-response.dto';

export type LoadedArticle = Pick<
  Article,
  'slug' | 'title' | 'description' | 'body' | 'createdAt' | 'updatedAt'
> & { author: Pick<User, 'username' | 'bio' | 'image'> };

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
  return {
    slug: article.slug,
    title: article.title,
    description: article.description,
    body: article.body,
    tagList: [...metadata.tagList],
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    favorited: metadata.favorited,
    favoritesCount: metadata.favoritesCount,
    author: {
      username: article.author.username,
      bio: article.author.bio,
      image: article.author.image,
      following: metadata.following,
    },
  };
}
