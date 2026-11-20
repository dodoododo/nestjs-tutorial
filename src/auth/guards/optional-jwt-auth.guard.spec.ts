import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

describe('OptionalJwtAuthGuard', () => {
  const guard = new OptionalJwtAuthGuard();

  function context(authorization?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization } }),
      }),
    } as unknown as ExecutionContext;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows anonymous access only when the authorization header is absent', () => {
    const jwtCheck = jest.spyOn(JwtAuthGuard.prototype, 'canActivate');
    expect(guard.canActivate(context())).toBe(true);
    expect(jwtCheck).not.toHaveBeenCalled();
  });

  it('delegates supplied credentials to the existing JWT guard', async () => {
    const jwtCheck = jest
      .spyOn(JwtAuthGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
    const requestContext = context('Bearer valid-token');
    await expect(guard.canActivate(requestContext)).resolves.toBe(true);
    expect(jwtCheck).toHaveBeenCalledWith(requestContext);
  });

  it.each(['', 'Bearer', 'Basic credentials', 'Bearer invalid.jwt.token'])(
    'does not swallow authentication errors for supplied credentials: %j',
    async (authorization) => {
      const error = new UnauthorizedException();
      jest
        .spyOn(JwtAuthGuard.prototype, 'canActivate')
        .mockRejectedValue(error);
      await expect(guard.canActivate(context(authorization))).rejects.toBe(
        error,
      );
    },
  );

  it('propagates a Redis availability error rather than becoming anonymous', async () => {
    const error = new ServiceUnavailableException();
    jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockRejectedValue(error);
    await expect(guard.canActivate(context('Bearer token'))).rejects.toBe(
      error,
    );
  });
});
