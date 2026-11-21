import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class EmptyFavoriteInputPipe implements PipeTransform<unknown, void> {
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
      'Favorite endpoints accept no request fields',
    );
  }
}
