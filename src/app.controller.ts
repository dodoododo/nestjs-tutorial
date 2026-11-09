import { Controller, Get } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('hello')
@Controller('hello')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Get a localized Hello World message',
  })
  @ApiQuery({
    name: 'lang',
    required: false,
    example: 'vi',
    description: 'Language code (en or vi). Defaults to English.',
  })
  @ApiHeader({
    name: 'x-lang',
    required: false,
    description: 'Optional language header',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: 'Standard language preference header',
  })
  @ApiOkResponse({
    description: 'Localized greeting returned successfully',
    schema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          example: 'Hello World!',
        },
      },
    },
  })
  getHello(): { message: string } {
    return this.appService.getHello();
  }
}
