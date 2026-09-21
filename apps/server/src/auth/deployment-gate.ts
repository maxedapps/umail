import { readAuthControl, type AuthControlDatabase } from "./auth-control.ts";

export function isPublicAuthDiscoveryPath(pathname: string): boolean {
  return (
    pathname === "/jwks" || pathname === "/api/auth/jwks" || pathname.startsWith("/.well-known/")
  );
}

export function provisioningUnavailableResponse(): Response {
  return new Response(JSON.stringify({ message: "Authentication is not ready" }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function gatedAuthHandler(
  database: AuthControlDatabase,
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (isPublicAuthDiscoveryPath(pathname) && request.method === "GET") {
    return handler(request);
  }

  const before = await readAuthControl(database);
  if (before === null || !before.ready) {
    return provisioningUnavailableResponse();
  }

  const response = await handler(request);
  const after = await readAuthControl(database);
  if (
    after === null ||
    !after.ready ||
    after.credentialGeneration !== before.credentialGeneration
  ) {
    return provisioningUnavailableResponse();
  }
  return response;
}
