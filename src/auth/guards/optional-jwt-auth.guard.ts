import { ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();

    // Only missing credentials are anonymous. All supplied credentials must pass
    // the existing JWT strategy, including its Redis revocation check.
    if (request.headers.authorization === undefined) {
      return true;
    }

    return super.canActivate(context);
  }
}
