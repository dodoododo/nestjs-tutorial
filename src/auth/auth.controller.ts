import {
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { RegisterRequestDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';

@ApiTags('Authentication')
@Controller('users')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid registration data' })
  @ApiConflictResponse({ description: 'User already exists' })
  register(@Body() body: RegisterRequestDto): Promise<UserResponseDto> {
    return this.authService.register(body.user);
  }
}
