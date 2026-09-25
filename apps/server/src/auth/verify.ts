import {
  CurrentPrincipal,
  PrincipalAuthorization,
  operatorOAuthPrincipal,
  UMAIL_OAUTH_SCOPE,
} from "@umail/api-contract";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { type UmailAuthInstance } from "./options.ts";
import { verifyOAuthBearerToken } from "./oauth-resource.ts";

type OperatorAuthorizationDependencies = {
  readonly auth: UmailAuthInstance;
  readonly issuer: string;
  readonly resource: string;
};

const authenticateOperatorBearer = Effect.fn("authenticateOperatorBearer")(function* (
  deps: OperatorAuthorizationDependencies,
  token: string,
) {
  const access = yield* verifyOAuthBearerToken(deps.auth, token, {
    issuer: deps.issuer,
    audience: deps.resource,
    scopes: [UMAIL_OAUTH_SCOPE],
  }).pipe(Effect.mapError(() => new HttpApiError.Unauthorized()));
  return operatorOAuthPrincipal(access.subject, access.clientId);
});

export function makePrincipalAuthorizationLive(deps: OperatorAuthorizationDependencies) {
  return Layer.succeed(PrincipalAuthorization, {
    bearer: (httpEffect, { credential }) =>
      authenticateOperatorBearer(deps, Redacted.value(credential)).pipe(
        Effect.flatMap((principal) =>
          Effect.provideService(httpEffect, CurrentPrincipal, principal),
        ),
        // The shared contract's middleware declares no requirements. It always runs inside a
        // request, whose fiber carries alchemy's RuntimeContext, so the phantom only satisfies the
        // type.
        Effect.provide(RuntimeContext.phantom),
      ),
  });
}
