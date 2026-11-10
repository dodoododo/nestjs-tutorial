import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from 'nestjs-i18n';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const i18nMock = {
    t: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    i18nMock.t.mockReturnValue('Hello World!');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: I18nService,
          useValue: i18nMock,
        },
      ],
    }).compile();

    appController = module.get<AppController>(AppController);
  });

  it('should return the translated hello message', () => {
    expect(appController.getHello()).toEqual({
      message: 'Hello World!',
    });

    expect(i18nMock.t).toHaveBeenCalledWith('common.HELLO');
  });
});
