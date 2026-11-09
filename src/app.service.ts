import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';

@Injectable()
export class AppService {
  constructor(private readonly i18n: I18nService) {}

  getHello(): { message: string } {
    return {
      message: this.i18n.t('common.HELLO'),
    };
  }
}
