import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type {
  AuthenticatedPrincipal,
  AuthenticatedRequest,
} from '../interfaces/authenticated-request.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    return request.user;
  },
);
