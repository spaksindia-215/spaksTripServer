import { Response, CookieOptions } from "express";
import { env, isProd } from "../config/env";
import { ADMIN_COOKIE_NAME, ADMIN_COOKIE_MAX_AGE_MS } from "./adminSession";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_PATH = "/api/auth";

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const shouldUseCrossSiteCookies = isProd || !isLocalhostOrigin(env.clientOrigin);

const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: shouldUseCrossSiteCookies,
  sameSite: shouldUseCrossSiteCookies ? "none" : "lax",
  path: "/",
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie("accessToken", accessToken, { ...baseOptions, maxAge: ACCESS_MAX_AGE_MS });
  res.cookie("refreshToken", refreshToken, {
    ...baseOptions,
    maxAge: REFRESH_MAX_AGE_MS,
    path: REFRESH_PATH,
  });
}

export function setAccessCookie(res: Response, accessToken: string): void {
  res.cookie("accessToken", accessToken, { ...baseOptions, maxAge: ACCESS_MAX_AGE_MS });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie("accessToken", baseOptions);
  res.clearCookie("refreshToken", { ...baseOptions, path: REFRESH_PATH });
}

export function setAdminCookie(res: Response, token: string): void {
  res.cookie(ADMIN_COOKIE_NAME, token, { ...baseOptions, maxAge: ADMIN_COOKIE_MAX_AGE_MS });
}

export function clearAdminCookie(res: Response): void {
  res.clearCookie(ADMIN_COOKIE_NAME, baseOptions);
}
