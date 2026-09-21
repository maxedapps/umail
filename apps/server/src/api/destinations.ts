import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type CloudflareDestination = {
  readonly cloudflareId: string;
  readonly email: string;
  readonly verifiedAt: string | null;
};

export class DestinationsError extends Schema.TaggedError<DestinationsError>()(
  "DestinationsError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export interface DestinationsClient {
  create(email: string): Effect.Effect<CloudflareDestination, DestinationsError>;
  get(cloudflareId: string): Effect.Effect<CloudflareDestination, DestinationsError>;
  delete(cloudflareId: string): Effect.Effect<void, DestinationsError>;
}

export type StoredForwardingDestination = {
  readonly id: string;
  readonly cloudflareId: string;
};

export interface DestinationAccountCommands {
  readonly getDestination: (id: string) => Effect.Effect<StoredForwardingDestination | null>;
  readonly insertDestination: (
    created: CloudflareDestination,
    nowIso: string,
  ) => Effect.Effect<StoredForwardingDestination>;
  readonly deleteDestination: (id: string, nowIso: string) => Effect.Effect<void>;
}

const CloudflareAddress = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  verified: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CloudflareErrorItem = Schema.Struct({
  code: Schema.optionalKey(Schema.Finite),
  message: Schema.String,
});

const CloudflareErrorEnvelope = Schema.Struct({
  errors: Schema.Array(CloudflareErrorItem),
});

const CloudflareEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optionalKey(Schema.NullOr(CloudflareAddress)),
  errors: Schema.optionalKey(Schema.Array(CloudflareErrorItem)),
});

const EMAIL_ADDRESS_NOT_FOUND = 2015;

const FALLBACK_MESSAGE = "Could not create the forwarding destination.";

export type CloudflareDestinationsConfig = {
  readonly token: Redacted.Redacted<string>;
  readonly accountId: string;
};

export function cloudflareDestinationsClient(
  config: CloudflareDestinationsConfig,
): DestinationsClient {
  return {
    create: (email) =>
      requestJson(config, "POST", "", { email }).pipe(
        Effect.flatMap((envelope) => decodeDestination(envelope)),
      ),
    get: (cloudflareId) =>
      requestJson(config, "GET", `/${cloudflareId}`).pipe(
        Effect.flatMap((envelope) => decodeDestination(envelope)),
      ),
    delete: (cloudflareId) => requestJson(config, "DELETE", `/${cloudflareId}`).pipe(Effect.asVoid),
  };
}

export function createStoredDestination(
  client: DestinationsClient,
  account: DestinationAccountCommands,
  email: string,
  nowIso: string,
): Effect.Effect<StoredForwardingDestination, DestinationsError> {
  return client
    .create(email)
    .pipe(Effect.flatMap((created) => account.insertDestination(created, nowIso)));
}

export function deleteStoredDestination(
  client: DestinationsClient,
  account: DestinationAccountCommands,
  id: string,
  nowIso: string,
): Effect.Effect<void, DestinationsError> {
  return Effect.gen(function* () {
    const stored = yield* account.getDestination(id);
    if (stored === null) return;
    yield* client.delete(stored.cloudflareId);
    yield* account.deleteDestination(id, nowIso);
  });
}

function requestJson(
  config: CloudflareDestinationsConfig,
  method: "GET" | "POST" | "DELETE",
  pathSuffix: string,
  body?: { readonly email: string },
): Effect.Effect<typeof CloudflareEnvelope.Type, DestinationsError> {
  return Effect.gen(function* () {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${Redacted.value(config.token)}`,
        "content-type": "application/json",
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/routing/addresses${pathSuffix}`,
          init,
        ),
      catch: () =>
        new DestinationsError({
          reason: "request_failed",
          message: FALLBACK_MESSAGE,
        }),
    });
    const payloadJson = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new DestinationsError({
          reason: "request_failed",
          message: FALLBACK_MESSAGE,
        }),
    });
    const decoded = Schema.decodeUnknownResult(CloudflareEnvelope)(payloadJson);
    if (Result.isFailure(decoded)) {
      if (method === "DELETE" && response.status === 404) {
        return { success: true, result: null, errors: [] };
      }
      const errors = Schema.decodeUnknownResult(CloudflareErrorEnvelope)(payloadJson);
      return yield* new DestinationsError({
        reason: response.ok ? "decode_failed" : "http_failed",
        message: Result.isFailure(errors)
          ? FALLBACK_MESSAGE
          : userMessageFromErrors(errors.success.errors),
      });
    }
    const payload = decoded.success;
    if (method === "DELETE" && isAlreadyRemoved(response.status, payload)) {
      return { success: true, result: null, errors: [] };
    }
    if (!response.ok || payload.success === false) {
      return yield* new DestinationsError({
        reason: "http_failed",
        message: userMessageFromErrors(payload.errors),
      });
    }
    return payload;
  });
}

function isAlreadyRemoved(status: number, envelope: typeof CloudflareEnvelope.Type): boolean {
  if (status === 404) return true;
  return envelope.errors?.some((error) => error.code === EMAIL_ADDRESS_NOT_FOUND) === true;
}

function decodeDestination(
  envelope: typeof CloudflareEnvelope.Type,
): Effect.Effect<CloudflareDestination, DestinationsError> {
  const result = envelope.result;
  if (!envelope.success || result === undefined || result === null) {
    return Effect.fail(
      new DestinationsError({
        reason: "decode_failed",
        message: userMessageFromErrors(envelope.errors),
      }),
    );
  }
  return Effect.succeed(toDestination(result));
}

function userMessageFromErrors(
  errors: ReadonlyArray<typeof CloudflareErrorItem.Type> | undefined,
): string {
  if (errors === undefined) {
    return FALLBACK_MESSAGE;
  }
  const first = errors[0];
  if (first === undefined) {
    return FALLBACK_MESSAGE;
  }
  return first.message;
}

function toDestination(address: typeof CloudflareAddress.Type): CloudflareDestination {
  const verified = address.verified;
  return {
    cloudflareId: address.id,
    email: address.email,
    verifiedAt: verified === undefined ? null : verified,
  };
}
