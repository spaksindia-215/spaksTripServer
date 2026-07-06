import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import type { Role } from "../models/User";

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  email: string;
}

export interface RefreshTokenPayload {
  sub: string;
  tokenType: "refresh";
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.accessSecret, { expiresIn: env.accessTtl } as SignOptions);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.refreshSecret, { expiresIn: env.refreshTtl } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.accessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.refreshSecret) as RefreshTokenPayload;
}
