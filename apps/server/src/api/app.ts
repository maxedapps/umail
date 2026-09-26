import type * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  ApprovalPageGone,
  ApprovalPageNotFound,
  ApprovalToken,
  CurrentPrincipal,
  InvalidRequest,
  PublicApprovalApi,
  RequestErrors,
  UmailApi,
  type MailDomain,
  type Principal,
} from "@umail/api-contract";

import type { MailHtmlPolicy } from "../mail/html-policy.ts";
import type { AccountStoreRpc } from "../account/worker.ts";
import { decideApproval, reviewApproval } from "./approval-http.ts";
import { attachmentResponseHeaders, rfc6266ContentDisposition } from "./attachments.ts";
import type { Access } from "../auth/access.ts";
import type { UmailAuthInstance } from "../auth/options.ts";
import { makePrincipalAuthorizationLive } from "../auth/verify.ts";
import type { DestinationsClient } from "./destinations.ts";
import { WebCrypto } from "../crypto.ts";
import { webRoutes } from "../web/routes.ts";
import {
  BODY_FRAME_CSP,
  approvalHttpApiBody,
  bodyDocument,
  bodyFrameHeaders,
} from "../web/document.ts";
import {
  approvalGonePage,
  approvalNotFoundPage,
  approvalReviewPage,
} from "../web/pages/approval.ts";
import { approvalReviewUrl, type NotificationKey } from "../mail/notifications.ts";
import {
  createAddress,
  currentIso,
  getAddress,
  getJob,
  getMessage,
  getThread,
  listJobs,
  listMessages,
  listSendingIdentities,
  listThreads,
  listAddresses,
  patchAddress,
  readAttachment,
  readMessageSource,
  removeAddressForwarding,
  setAddressForwarding,
  setThreadReadState,
  softDeleteVisibleThread,
  submitMessage,
} from "./operations.ts";

export class ArchiveTransportError extends Schema.TaggedError<ArchiveTransportError>()(
  "ArchiveTransportError",
  { key: Schema.String },
) {}

export type MailArchiveReader = {
  get(key: string): Effect.Effect<Uint8Array | null, ArchiveTransportError, Alchemy.RuntimeContext>;
};

export type ApiDeps = {
  readonly account: AccountStoreRpc;
  readonly archive: MailArchiveReader;
  readonly destinations: DestinationsClient;
  readonly htmlPolicy: MailHtmlPolicy;
  readonly mailDomain: MailDomain;
  readonly auth: UmailAuthInstance;
  readonly access: Access;
  readonly applicationUrl: URL;
  readonly operatorId: string;
  readonly notificationKey: Effect.Effect<NotificationKey>;
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

function apiLayers(deps: ApiDeps) {
  return Layer.mergeAll(
    addressesGroup(deps),
    sendingIdentitiesGroup(deps),
    threadsGroup(deps),
    messagesGroup(deps),
    submissionsGroup(deps),
    jobsGroup(deps),
    publicApprovalsGroup(deps),
    Etag.layer,
    HttpPlatformStub,
    Path.layer,
    FileSystem.layerNoop({}),
  );
}

// One router serves the REST API, the public approval pages, and every other route; it is built per
// request (see app.ts).
export function makeApiHttpEffect(deps: ApiDeps) {
  const appLayer = Layer.mergeAll(
    HttpApiBuilder.layer(UmailApi),
    HttpApiBuilder.layer(PublicApprovalApi),
    webRoutes(deps),
  );
  return HttpRouter.toHttpEffect(appLayer.pipe(Layer.provide(apiLayers(deps)))).pipe(
    Effect.provide(
      Layer.merge(
        makePrincipalAuthorizationLive({
          auth: deps.auth,
          issuer: `${deps.applicationUrl.origin}/api/auth`,
          resource: deps.applicationUrl.origin,
        }),
        RequestErrorsLive,
      ),
    ),
    Effect.map((handler) => handler.pipe(Effect.provide(WebCrypto))),
  );
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

// A request that does not decode answers 400 with its first issue, e.g. "Invalid payload:
// to.0.address: Expected a bare address like name@example.com". A response that does not encode is
// our bug, not the caller's: it dies with the bare schema error (a 500), because the wrapping
// HttpApiSchemaError would still render as an empty 400.
export const RequestErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestErrors,
  (error) => {
    if (error.kind === "Body" || error.kind === "ResponseHeaders") {
      return Effect.die(error.cause);
    }
    const [issue] = formatIssue(error.cause.issue).issues;
    const path = issue?.path?.map(String).join(".") ?? "";
    const detail = path.length === 0 ? issue?.message : `${path}: ${issue?.message}`;
    return Effect.fail(
      new InvalidRequest({
        code: "invalid_request",
        message: `Invalid ${error.kind.toLowerCase()}: ${detail}`,
      }),
    );
  },
);

function addressesGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Addresses", (handlers) =>
    handlers
      .handle("createAddress", ({ payload }) => createAddress(deps, payload))
      .handle("listAddresses", () => listAddresses(deps))
      .handle("getAddress", ({ params }) => getAddress(deps, params.id))
      .handle("patchAddress", ({ params, payload }) => patchAddress(deps, params.id, payload))
      .handle("setForwarding", ({ params, payload }) =>
        setAddressForwarding(deps, params.id, payload.email),
      )
      .handle("removeForwarding", ({ params }) => removeAddressForwarding(deps, params.id)),
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

function threadsGroup(deps: ApiDeps) {
  return HttpApiBuilder.group(UmailApi, "Threads", (handlers) =>
    handlers
      .handle("listThreads", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* listThreads(deps, principal, query.limit, query.cursor);
        }),
      )
      .handle("getThread", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* getThread(deps, principal, params.id, query);
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
      .handle("getMessage", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          return yield* getMessage(deps, principal, params.id);
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
      .handle("approveApproval", ({ params }) =>
        decideApprovalRoute(deps, params.token, "approved"),
      )
      .handle("denyApproval", ({ params }) => decideApprovalRoute(deps, params.token, "denied")),
  );
}

const showApproval = Effect.fn("showApproval")(function* (deps: ApiDeps, rawToken: string) {
  const token = yield* decodeApprovalToken(rawToken);
  const outcome = yield* reviewApproval(deps, token);
  if (outcome.kind === "notFound") {
    return yield* approvalNotFound;
  }
  if (outcome.kind === "gone") {
    return yield* approvalGone;
  }
  const now = yield* currentIso;
  return HttpApiSchema.withHeaders(
    yield* approvalHttpApiBody(
      approvalReviewPage(token, outcome.approval, outcome.message, outcome.job, now),
    ),
  );
});

const showApprovalMessagePreview = Effect.fn("showApprovalMessagePreview")(function* (
  deps: ApiDeps,
  rawToken: string,
) {
  const token = yield* decodeApprovalToken(rawToken);
  const outcome = yield* reviewApproval(deps, token);
  if (outcome.kind === "notFound") {
    return yield* approvalNotFound;
  }
  if (outcome.kind === "gone" || outcome.message.htmlBody === null) {
    return yield* approvalGone;
  }
  return HttpApiSchema.withHeaders({
    body: bodyDocument(outcome.message.htmlBody),
    headers: bodyFrameHeaders(BODY_FRAME_CSP),
  });
});

const decideApprovalRoute = Effect.fn("decideApprovalRoute")(function* (
  deps: ApiDeps,
  rawToken: string,
  decision: "approved" | "denied",
) {
  const token = yield* decodeApprovalToken(rawToken);
  const outcome = yield* decideApproval(deps, token, decision);
  if (outcome.kind === "notFound") {
    return yield* approvalNotFound;
  }
  if (outcome.kind === "gone") {
    return yield* approvalGone;
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

function decodeApprovalToken(rawToken: string) {
  return Schema.decodeEffect(ApprovalToken)(rawToken).pipe(Effect.catch(() => approvalNotFound));
}

const approvalNotFound = Effect.flatMap(approvalHttpApiBody(approvalNotFoundPage()), (page) =>
  Effect.fail(new ApprovalPageNotFound({ html: page.body, headers: page.headers })),
);

const approvalGone = Effect.flatMap(approvalHttpApiBody(approvalGonePage()), (page) =>
  Effect.fail(new ApprovalPageGone({ html: page.body, headers: page.headers })),
);

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
