export const AUTH_BASE_PATH = "/api/auth" as const;

export const DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/delete-user/callback",
  "/link-social",
  "/unlink-account",
  "/send-verification-email",
  "/verify-email",
  "/token",
] as const;

const DISABLED_AUTH_PATH_SET: ReadonlySet<string> = new Set(DISABLED_AUTH_PATHS);

export function blockedAuthSurfaceResponse(request: Request): Response | null {
  const relativePath = relativeAuthPath(new URL(request.url).pathname);
  if (relativePath === null) return null;
  if (
    DISABLED_AUTH_PATH_SET.has(relativePath) ||
    isBlockedAuthFamily(relativePath, request.method)
  ) {
    return new Response("Not Found", { status: 404 });
  }
  return null;
}

export function cookieMutationAllowed(request: Request, configuredOrigin: string): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") {
    return true;
  }
  const originHeader = request.headers.get("origin");
  return originHeader === configuredOrigin || originHeader === new URL(request.url).origin;
}

function relativeAuthPath(pathname: string): string | null {
  if (pathname === AUTH_BASE_PATH) return "/";
  const prefix = `${AUTH_BASE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  return `/${pathname.slice(prefix.length)}`;
}

function isBlockedAuthFamily(relativePath: string, method: string): boolean {
  if (relativePath.startsWith("/reset-password/")) return true;
  if (relativePath === "/callback" || relativePath.startsWith("/callback/")) return true;
  if (relativePath === "/admin" || relativePath.startsWith("/admin/")) return true;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return (
    relativePath === "/oauth2/create-client" ||
    relativePath === "/oauth2/update-client" ||
    relativePath === "/oauth2/delete-client" ||
    relativePath === "/oauth2/client/rotate-secret"
  );
}
