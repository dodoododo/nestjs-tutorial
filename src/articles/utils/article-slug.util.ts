import { ARTICLE_SLUG_MAX_LENGTH } from '../constants/article.constant';

export function articleSlug(title: string): string {
  // Fold Vietnamese accents (including đ); retain other Unicode letters/numbers.
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(slug || 'article')
    .slice(0, ARTICLE_SLUG_MAX_LENGTH)
    .join('')
    .replace(/-+$/, '');
}
