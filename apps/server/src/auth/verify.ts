import {
  CurrentPrincipal,
  PrincipalAuthorization,
  operatorOAuthPrincipal,
  type Principal,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { UMAIL_OAUTH_SCOPE, type UmailBetterAuth } from "./options.ts";
import { verifyOAuthBearerToken } from "./oauth-resource.ts";

export type OperatorAuthorizationDependencies = {
  readonly auth: UmailBetterAuth;
  readonly issuer: string;
  readonly resource: string;
};

export function authenticateOperatorBearer(
  deps: OperatorAuthorizationDependencies,
  token: string,
): Effect.Effect<Principal, HttpApiError.Unauthorized> {
  return Effect.gen(function* () {
    const access = yield* Effect.tryPromise({
      try: () =>
        verifyOAuthBearerToken(deps.auth, token, {
          issuer: deps.issuer,
          audience: deps.resource,
          scopes: [UMAIL_OAUTH_SCOPE],
        }),
      catch: () => new HttpApiError.Unauthorized(),
    });
    return operatorOAuthPrincipal(access.subject, access.clientId);
  });
}

export function makePrincipalAuthorizationLive(deps: OperatorAuthorizationDependencies) {
  return Layer.succeed(PrincipalAuthorization, {
    bearer: (httpEffect, { credential }) =>
      authenticateOperatorBearer(deps, Redacted.value(credential)).pipe(
        Effect.flatMap((principal) =>
          Effect.provideService(httpEffect, CurrentPrincipal, principal),
        ),
      ),
  });
}
