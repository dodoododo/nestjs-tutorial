import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';

@Injectable()
export class EmptyFavoriteInputPipe implements PipeTransform<unknown, void> {
  constructor(private readonly i18n: I18nService) {}

  transform(value: unknown): void {
    if (
      value === undefined ||
      (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    )
      return;
    throw new BadRequestException(
      this.i18n.t('articles.FAVORITE_INPUT_NOT_EMPTY'),
    );
  }
}
