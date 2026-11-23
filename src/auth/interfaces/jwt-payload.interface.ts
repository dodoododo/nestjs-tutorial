export interface JwtPayload {
  sub: string;
  jti: string;
  iat?: number;
  exp: number;
  // Absent only on legacy JWTs, interpreted as version 0.
  tokenVersion?: number;
}
