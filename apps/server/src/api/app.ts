import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import type { MailHtmlPolicy } from "@umail/mail-content";
import {
  ApprovalPageGone,
  ApprovalPageNotFound,
  ApprovalToken,
  ApiProblem,
  CurrentPrincipal,
  PublicApprovalApi,
  UmailApi,
  generateApprovalToken,
  type ApprovalToken as ApprovalTokenValue,
  type CreateDestinationPayload,
  type ExternalMailAddress,
  type ForwardingDestination,
  type MailDomain,
  type Principal,
} from "@umail/api-contract";

import type { ApiAccountStore } from "../account/worker.ts";
import { decideApproval, reviewApproval } from "./approval-http.ts";
import { approvalReviewUrl } from "./approvals.ts";
import { attachmentResponseHeaders, rfc6266ContentDisposition } from "./attachments.ts";
import type { AuthControlDatabase } from "../auth/auth-control.ts";
import { gatedAuthHandler } from "../auth/deployment-gate.ts";
import type { UmailBetterAuth } from "../auth/options.ts";
import { isOAuthRoute, serveOAuthRoute } from "../auth/oauth-routes.ts";
import { isAgentMailIconPath, serveAgentMailIcon } from "./brand/identity.ts";
import { consentPageResponse, loginPageResponse } from "./human-pages/auth.ts";
import { blockedAuthSurfaceResponse } from "../auth/runtime-surface.ts";
import { makePrincipalAuthorizationLive } from "../auth/verify.ts";
import type { DestinationsClient } from "./destinations.ts";
import {
  renderApprovalGonePage,
  renderApprovalMessagePreview,
  renderApprovalNotFoundPage,
  renderApprovalReviewPage,
} from "./human-pages/approvals.ts";
import {
  approvalMessagePreviewHttpApiResponse,
  humanPageHttpApiResponse,
} from "./human-pages/response.ts";
import { serveMcpRequest } from "./mcp/route.ts";
import type { NotificationKeyring } from "../mail/notifications.ts";
import {
  getJob,
  getMessage,
  getReplyPlan,
  getThread,
  listJobs,
  listMessages,
  listMcpClients,
  getMcpClient,
  setMcpClientPolicy,
  listSendingIdentities,
  listThreadMessages,
  listThreads,
  readAttachment,
  readMessageSource,
  sendMessage,
  setThreadReadState,
  softDeleteVisibleThread,
  submitMessage,
} from "./operations.ts";
import { projectAddress, projectDestination } from "./projection.ts";
import { requireAdmin, requireDelete, requireRead } from "./principal.ts";

export class ArchiveTransportError extends Schema.TaggedError<ArchiveTransportError>()(
  "ArchiveTransportError",
  { key: Schema.String },
) {}

export type MailArchiveReader = {
  get(key: string): Effect.Effect<Uint8Array | null, ArchiveTransportError>;
};

export type InstantClock = {
  readonly now: Effect.Effect<DateTime.Utc>;
};

export type NotificationDeps = {
  readonly keyring: NotificationKeyring;
  readonly nextToken: () => ApprovalTokenValue;
};

export type ApiDeps = {
  readonly account: ApiAccountStore;
  readonly archive: MailArchiveReader;
  readonly destinations: DestinationsClient;
  readonly htmlPolicy: MailHtmlPolicy;
  readonly mailDomain: MailDomain;
  readonly auth: UmailBetterAuth;
  readonly authDatabase: AuthControlDatabase;
  readonly applicationUrl: URL;
  readonly operatorId: string;
  readonly approvalAdminEmail: ExternalMailAddress;
  readonly approvalClock: InstantClock;
  readonly notification: NotificationDeps;
};

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export function apiLayers(deps: ApiDeps) {
  return Layer.mergeAll(
    addressesGroup(deps),
    sendingIdentitiesGroup(deps),
    destinationsGroup(deps),
    threadsGroup(deps),
    messagesGroup(deps),
    submissionsGroup(deps),
    jobsGroup(deps),
    mcpClientsGroup(deps),
    publicApprovalsGroup(deps),
    Etag.layer,
    HttpPlatformStub,
    Path.layer,
    FileSystem.layerNoop({}),
  );
}

function makeRestHttpEffect(deps: ApiDeps) {
  const apiLayer = Layer.merge(
    HttpApiBuilder.layer(UmailApi),
    HttpApiBuilder.layer(PublicApprovalApi),
  );
  return HttpRouter.toHttpEffect(apiLayer.pipe(Layer.provide(apiLayers(deps)))).pipe(
    Effect.provide(
      makePrincipalAuthorizationLive({
        auth: deps.auth,
        issuer: `${deps.applicationUrl.origin}/api/auth`,
        resource: deps.applicationUrl.origin,
      }),
    ),
  );
}

export function makeApiHttpEffect(deps: ApiDeps) {
  return Effect.map(makeRestHttpEffect(deps), (restHandler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = new URL(request.url, "https://umail.invalid").pathname;
      if (isAgentMailIconPath(pathname)) {
        return serveAgentMailIcon(request.method);
      }
      if (pathname === "/mcp") {
        return yield* serveMcpRequest(deps);
      }
      if (pathname === "/login" && request.method === "GET") {
        return loginPageResponse();
      }
      if (pathname === "/consent" && request.method === "GET") {
        return consentPageResponse();
      }
      if (isOAuthRoute(pathname)) {
        return yield* serveOAuthManagement(deps);
      }
      if (
        pathname === "/jwks" ||
        pathname.startsWith("/api/auth/") ||
        pathname.startsWith("/.well-known/")
      ) {
        return yield* serveBetterAuth(deps);
      }
      return yield* restHandler;
    }),
  );
}

function serveBetterAuth(deps: ApiDeps) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = HttpServerRequest.toWebResult(request);
    if (Result.isFailure(webRequest)) {
      return yield* new HttpServerError({ reason: webRequest.failure });
    }
    const blocked = blockedAuthSurfaceResponse(webRequest.success);
    if (blocked !== null) {
      return HttpServerResponse.fromWeb(blocked);
    }
    const response = yield* Effect.promise(() =>
      gatedAuthHandler(
        deps.authDatabase,
        (authRequest) => deps.auth.handler(authRequest),
        webRequest.success,
      ),
    );
    return HttpServerResponse.fromWeb(response);
  });
}

function serveOAuthManagement(deps: ApiDeps) {
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const webRequest = HttpServerRequest.toWebResult(request);
    if (Result.isFailure(webRequest)) {
      return new HttpServerError({ reason: webRequest.failure });
    }
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
    return Effect.promise(() =>
      serveOAuthRoute({ ...deps, operatorId: deps.operatorId, run }, webRequest.success),
    ).pipe(Effect.map((response) => HttpServerResponse.fromWeb(response)));
  });
}

export function makeApiWebHandler(deps: ApiDeps) {
  return Effect.gen(function* () {
    return HttpEffect.toWebHandler(yield* makeApiHttpEffect(deps));
  });
}

function addressesGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Addresses", (handlers) =>
    handlers
      .handle("createAddress", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const now = yield* currentIso(deps);
          const address = yield* deps.account
            .createAddress(payload.localPart, deps.mailDomain, payload.displayName, now)
            .pipe(Effect.mapError(toBadRequest));
          if (address === null) {
            return yield* new HttpApiError.BadRequest();
          }
          return projectAddress(address);
        }),
      )
      .handle("listAddresses", () =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const addresses = yield* deps.account.listAddresses().pipe(Effect.mapError(toBadRequest));
          return addresses.map(projectAddress);
        }),
      )
      .handle("getAddress", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const address = yield* deps.account
            .getAddress(params.id)
            .pipe(Effect.mapError(toBadRequest));
          if (address === null) {
            return yield* new HttpApiError.NotFound();
          }
          return projectAddress(address);
        }),
      )
      .handle("patchAddress", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const now = yield* currentIso(deps);
          const address = yield* deps.account
            .patchAddress(params.id, payload, now)
            .pipe(Effect.mapError(toBadRequest));
          if (address === null) {
            return yield* new HttpApiError.NotFound();
          }
          return projectAddress(address);
        }),
      )
      .handle("associateForwarding", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const now = yield* currentIso(deps);
          const address = yield* deps.account
            .setAddressForwarding(params.id, payload.destinationId, now)
            .pipe(Effect.mapError(toBadRequest));
          if (address === null) {
            return yield* new HttpApiError.BadRequest();
          }
          return projectAddress(address);
        }),
      )
      .handle("removeForwarding", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const now = yield* currentIso(deps);
          const address = yield* deps.account
            .setAddressForwarding(params.id, null, now)
            .pipe(Effect.mapError(toBadRequest));
          if (address === null) {
            return yield* new HttpApiError.NotFound();
          }
          return projectAddress(address);
        }),
      ),
  );
}

function sendingIdentitiesGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "SendingIdentities", (handlers) =>
    handlers.handle("listSendingIdentities", () =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        return yield* listSendingIdentities(deps, principal);
      }),
    ),
  );
}

function mcpClientsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "McpClients", (handlers) =>
    handlers
      .handle("listMcpClients", () =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* listMcpClients(deps);
        }),
      )
      .handle("getMcpClient", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* getMcpClient(deps, params.id);
        }),
      )
      .handle("setMcpClientPolicy", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* setMcpClientPolicy(deps, params.id, payload);
        }),
      ),
  );
}

function destinationsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Destinations", (handlers) =>
    handlers
      .handle("createDestination", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* createDestination(deps, payload);
        }),
      )
      .handle("listDestinations", () =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          const destinations = yield* deps.account
            .listDestinations()
            .pipe(Effect.mapError(toBadRequest));
          return destinations.map(projectDestination);
        }),
      )
      .handle("getDestination", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* refreshDestination(deps, params.id);
        }),
      )
      .handle("deleteDestination", ({ params }) =>
        Effect.gen(function* () {
          yield* requireAdmin(yield* CurrentPrincipal);
          return yield* removeDestination(deps, params.id);
        }),
      ),
  );
}

function threadsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Threads", (handlers) =>
    handlers
      .handle("listThreads", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* listThreads(deps, principal, query.limit, query.cursor);
        }),
      )
      .handle("getThread", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* getThread(deps, principal, params.id);
        }),
      )
      .handle("listThreadMessages", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* listThreadMessages(deps, principal, params.id, query);
        }),
      )
      .handle("markThreadRead", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* setThreadReadState(deps, principal, params.id, true);
        }),
      )
      .handle("markThreadUnread", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* setThreadReadState(deps, principal, params.id, false);
        }),
      )
      .handle("softDeleteThread", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          yield* requireDelete(principal);
          yield* softDeleteVisibleThread(deps, principal, params.id);
        }),
      ),
  );
}

function messagesGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Messages", (handlers) =>
    handlers
      .handle("listMessages", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* listMessages(deps, principal, query);
        }),
      )
      .handle("sendMessage", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* sendMessage(deps, principal, payload);
        }),
      )
      .handle("getMessage", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* getMessage(deps, principal, params.id);
        }),
      )
      .handle("getReplyPlan", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          yield* requireRead(principal);
          return yield* getReplyPlan(deps, principal, params.id, query.mode);
        }),
      )
      .handle("getAttachment", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* serveAttachment(deps, principal, params.id, params.attachmentId);
        }),
      )
      .handle("getMessageSource", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* serveMessageSource(deps, principal, params.id);
        }),
      ),
  );
}

function submissionsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Submissions", (handlers) =>
    handlers.handle("submitMessage", ({ payload }) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        return yield* submitMessage(deps, principal, payload);
      }),
    ),
  );
}

function jobsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Jobs", (handlers) =>
    handlers
      .handle("listJobs", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* listJobs(deps, principal, query);
        }),
      )
      .handle("getJob", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* getJob(deps, principal, params.id);
        }),
      ),
  );
}

function publicApprovalsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(PublicApprovalApi, "PublicApprovals", (handlers) =>
    handlers
      .handle("reviewApproval", ({ params }) => showApproval(deps, params.token))
      .handle("previewApprovalMessage", ({ params }) =>
        showApprovalMessagePreview(deps, params.token),
      )
      .handle("approveApproval", ({ params }) => approveApproval(deps, params.token))
      .handle("denyApproval", ({ params }) => denyApproval(deps, params.token)),
  );
}

function showApproval(deps: ApiDeps, rawToken: string) {
  return Effect.gen(function* () {
    const token = yield* decodeApprovalToken(rawToken);
    const outcome = yield* reviewApproval(deps, token);
    if (outcome.kind === "notFound") {
      return yield* approvalNotFoundError();
    }
    if (outcome.kind === "gone") {
      return yield* approvalGoneError();
    }
    return humanPageHttpApiResponse(
      renderApprovalReviewPage(token, outcome.approval, outcome.message, outcome.job),
    ).value;
  });
}

function showApprovalMessagePreview(deps: ApiDeps, rawToken: string) {
  return Effect.gen(function* () {
    const token = yield* decodeApprovalToken(rawToken);
    const outcome = yield* reviewApproval(deps, token);
    if (outcome.kind === "notFound") {
      return yield* approvalNotFoundError();
    }
    if (outcome.kind === "gone" || outcome.message.htmlBody === null) {
      return yield* approvalGoneError();
    }
    return approvalMessagePreviewHttpApiResponse(
      renderApprovalMessagePreview({
        storedHtml: {
          body: outcome.message.htmlBody,
          hasRemoteImages: outcome.message.hasRemoteImages,
        },
      }),
    );
  });
}

function approveApproval(deps: ApiDeps, rawToken: string) {
  return decideApprovalRoute(deps, rawToken, "approved");
}

function denyApproval(deps: ApiDeps, rawToken: string) {
  return decideApprovalRoute(deps, rawToken, "denied");
}

function decideApprovalRoute(deps: ApiDeps, rawToken: string, decision: "approved" | "denied") {
  return Effect.gen(function* () {
    const token = yield* decodeApprovalToken(rawToken);
    const outcome = yield* decideApproval(deps, token, decision);
    if (outcome.kind === "notFound") {
      return yield* approvalNotFoundError();
    }
    if (outcome.kind === "gone" || outcome.state === "pending") {
      return yield* approvalGoneError();
    }
    const headers = {
      location: approvalReviewUrl(deps.applicationUrl, token),
      "x-umail-approval-state": outcome.state,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    } as const;
    return HttpApiSchema.withHeaders({
      body: undefined,
      headers,
    });
  });
}

function decodeApprovalToken(rawToken: string) {
  return Schema.decodeEffect(ApprovalToken)(rawToken).pipe(
    Effect.mapError(() => approvalNotFoundError()),
  );
}

function approvalNotFoundError(): ApprovalPageNotFound {
  const response = humanPageHttpApiResponse(renderApprovalNotFoundPage()).value;
  return new ApprovalPageNotFound({
    html: response.body,
    headers: response.headers,
  });
}

function approvalGoneError(): ApprovalPageGone {
  const response = humanPageHttpApiResponse(renderApprovalGonePage()).value;
  return new ApprovalPageGone({
    html: response.body,
    headers: response.headers,
  });
}

function createDestination(
  deps: ApiDeps,
  payload: CreateDestinationPayload,
): Effect.Effect<ForwardingDestination, ApiProblem> {
  return Effect.gen(function* () {
    const now = yield* currentIso(deps);
    const created = yield* deps.destinations
      .create(payload.email)
      .pipe(Effect.mapError((error) => new ApiProblem({ message: error.message })));
    const stored = yield* deps.account
      .insertDestination(created.cloudflareId, created.email, created.verifiedAt, now)
      .pipe(
        Effect.mapError(
          () => new ApiProblem({ message: "Could not store the forwarding destination." }),
        ),
      );
    return projectDestination(stored);
  });
}

function refreshDestination(
  deps: ApiDeps,
  id: string,
): Effect.Effect<ForwardingDestination, HttpApiError.NotFound | HttpApiError.BadRequest> {
  return Effect.gen(function* () {
    const stored = yield* deps.account.getDestination(id).pipe(Effect.mapError(toBadRequest));
    if (stored === null) {
      return yield* new HttpApiError.NotFound();
    }
    const remote = yield* deps.destinations.get(stored.cloudflareId).pipe(Effect.option);
    if (remote._tag === "None") {
      return projectDestination(stored);
    }
    const now = yield* currentIso(deps);
    const updated = yield* deps.account
      .updateDestinationStatus(id, remote.value.verifiedAt, now)
      .pipe(Effect.mapError(toBadRequest));
    if (updated === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectDestination(updated);
  });
}

function removeDestination(
  deps: ApiDeps,
  id: string,
): Effect.Effect<void, HttpApiError.NotFound | HttpApiError.BadRequest> {
  return Effect.gen(function* () {
    const stored = yield* deps.account.getDestination(id).pipe(Effect.mapError(toBadRequest));
    if (stored === null) {
      return yield* new HttpApiError.NotFound();
    }
    yield* deps.destinations
      .delete(stored.cloudflareId)
      .pipe(Effect.mapError(() => new HttpApiError.BadRequest()));
    const now = yield* currentIso(deps);
    yield* deps.account.deleteDestination(id, now).pipe(Effect.mapError(toBadRequest));
  });
}

function serveAttachment(
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  attachmentId: string,
) {
  return Effect.map(readAttachment(deps, principal, messageId, attachmentId), ({ stored, bytes }) =>
    HttpApiSchema.withHeaders({
      body: bytes,
      headers: attachmentResponseHeaders(stored.meta.mimeType, stored.meta.filename),
    }),
  );
}

function serveMessageSource(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.map(readMessageSource(deps, principal, messageId), (bytes) =>
    HttpApiSchema.withHeaders({
      body: bytes,
      headers: {
        "content-type": "message/rfc822",
        "content-disposition": rfc6266ContentDisposition("attachment", `${messageId}.eml`),
        "x-content-type-options": "nosniff",
      },
    }),
  );
}

function currentIso(deps: ApiDeps) {
  return Effect.map(deps.approvalClock.now, DateTime.formatIso);
}

function toBadRequest(_error: { readonly _tag: string }): HttpApiError.BadRequest {
  return new HttpApiError.BadRequest();
}

export function defaultApprovalTokenSource(): NotificationDeps["nextToken"] {
  return generateApprovalToken;
}
