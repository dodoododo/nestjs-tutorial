import type { Request } from 'express';
import type { User } from '../../database/entities/user.entity';

export interface AuthenticatedPrincipal {
  user: User;
  token: string;
  jti: string;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedPrincipal;
}
