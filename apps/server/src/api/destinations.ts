import { fromApiToken } from "@distilled.cloud/cloudflare";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// Forwarding destinations are account-wide Cloudflare resources, and Cloudflare alone knows whether
// one is verified. AgentMail keeps no copy: it adopts the destination or creates it, and reads its
// verification live.

export class DestinationError extends Schema.TaggedError<DestinationError>()("DestinationError", {
  message: Schema.String,
}) {}

export type ForwardingDestination = {
  readonly email: string;
  readonly verified: boolean;
};

export interface DestinationsClient {
  ensure(email: string): Effect.Effect<ForwardingDestination, DestinationError>;
}

export function cloudflareDestinations(config: {
  readonly token: Redacted.Redacted<string>;
  readonly accountId: string;
}): DestinationsClient {
  const cloudflare = Layer.merge(
    fromApiToken({ apiToken: Redacted.value(config.token) }),
    FetchHttpClient.layer,
  );
  const accountId = config.accountId;
  return {
    ensure: (email) =>
      Effect.gen(function* () {
        const wanted = email.toLowerCase();
        const existing = yield* emailRouting.listAddresses.items({ accountId }).pipe(
          Stream.filter((address) => address.email?.toLowerCase() === wanted),
          Stream.runHead,
        );
        const address = Option.isSome(existing)
          ? existing.value
          : yield* emailRouting.createAddress({ accountId, email });
        return { email: address.email ?? email, verified: typeof address.verified === "string" };
      }).pipe(
        // Cloudflare's own message (e.g. an address it will not accept) is shown as is.
        Effect.mapError(
          (error) =>
            new DestinationError({
              message:
                error._tag === "HttpClientError" || error.message.length === 0
                  ? "Could not reach Cloudflare."
                  : error.message,
            }),
        ),
        Effect.provide(cloudflare),
      ),
  };
}
