import { Retry, fromApiToken } from "@distilled.cloud/cloudflare";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { InvalidRequest, Unavailable } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// Forwarding destinations are account-wide Cloudflare resources, and Cloudflare alone knows whether
// one is verified. AgentMail keeps no copy: it adopts the destination or creates it, and reads its
// verification live.

export type ForwardingDestination = {
  readonly email: string;
  readonly verified: boolean;
};

export interface DestinationsClient {
  ensure(email: string): Effect.Effect<ForwardingDestination, InvalidRequest | Unavailable>;
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
    ensure: Effect.fn("DestinationsClient.ensure")(
      function* (email: string) {
        const wanted = email.toLowerCase();
        const existing = yield* emailRouting.listAddresses.items({ accountId }).pipe(
          Stream.filter((address) => address.email?.toLowerCase() === wanted),
          Stream.runHead,
        );
        const address = Option.isSome(existing)
          ? existing.value
          : yield* emailRouting.createAddress({ accountId, email });
        return { email: address.email ?? email, verified: typeof address.verified === "string" };
      },
      Retry.none,
      Effect.catch(classifyCloudflareError),
      Effect.provide(cloudflare),
    ),
  };
}

// Cloudflare's message is shown when it is about the address or the rate; a refused token means
// the deploy is misconfigured. Anything else (network, 5xx, parse) is an outage. Retries are off:
// the default policy retries auth errors and 429s for about 20 s, which would hang the form.
function classifyCloudflareError(error: {
  readonly _tag: string;
  readonly message: string;
}): Effect.Effect<never, InvalidRequest | Unavailable> {
  switch (error._tag) {
    case "BadRequest":
    case "UnprocessableEntity":
    case "Conflict":
      return Effect.fail(
        new InvalidRequest({ code: "forwarding_rejected", message: error.message }),
      );
    case "TooManyRequests":
      return Effect.fail(
        new Unavailable({
          code: "cloudflare_unavailable",
          message: `${error.message.replace(/\.?$/, ".")} Try again later.`,
        }),
      );
    case "Unauthorized":
    case "Forbidden":
    case "InvalidRoute":
    case "NotFound":
    case "ConfigError":
      return Effect.logError("Cloudflare refused the Email Routing token", error).pipe(
        Effect.andThen(
          Effect.fail(
            new Unavailable({
              code: "cloudflare_misconfigured",
              message:
                "Cloudflare refused CF_EMAIL_ROUTING_TOKEN. Give it Email Routing Addresses edit access on this account and redeploy.",
            }),
          ),
        ),
      );
    default:
      return Effect.logError("Cloudflare Email Routing call failed", error).pipe(
        Effect.andThen(
          Effect.fail(
            new Unavailable({
              code: "cloudflare_unavailable",
              message: "Cloudflare Email Routing is unavailable. Try again.",
            }),
          ),
        ),
      );
  }
}
