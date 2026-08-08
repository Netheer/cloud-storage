export type AccessTokenPayload = {
  sub: string;
  sid: string;
  email: string;
  type: 'access';
  jti: string;
  iat?: number;
  exp?: number;
};
