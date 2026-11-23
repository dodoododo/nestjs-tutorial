import { randomBytes } from 'node:crypto';
import {
  ARTICLE_SLUG_MAX_LENGTH,
  ARTICLE_SLUG_RANDOM_BYTES,
} from '../constants/article.constant';

export function articleSlug(title: string): string {
  // Fold Vietnamese accents (including đ); retain other Unicode letters/numbers.
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = randomBytes(ARTICLE_SLUG_RANDOM_BYTES).toString('hex');
  const prefixLimit = ARTICLE_SLUG_MAX_LENGTH - suffix.length - 1;
  let prefix = '';
  // Bound UTF-16 length as well as database character length, keeping pairs intact.
  for (const character of slug || 'article') {
    if (prefix.length + character.length > prefixLimit) break;
    prefix += character;
  }
  return `${prefix.replace(/-+$/, '')}-${suffix}`;
}
