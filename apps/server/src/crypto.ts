import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

// Effect's Crypto service over WebCrypto, which both workerd and Node provide.
export const webCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => crypto.subtle.digest(algorithm, new Uint8Array(data))).pipe(
      Effect.map((digest) => new Uint8Array(digest)),
    ),
});

export const WebCrypto = Layer.succeed(Crypto.Crypto, webCrypto);

// WebCrypto does not fail for these calls, so a failure is a defect.
export const randomId = Effect.gen(function* () {
  const service = yield* Crypto.Crypto;
  return yield* service.randomUUIDv4;
}).pipe(Effect.orDie);

export const sha256Hex = Effect.fn("sha256Hex")(function* (bytes: Uint8Array) {
  const service = yield* Crypto.Crypto;
  return Encoding.encodeHex(yield* service.digest("SHA-256", bytes).pipe(Effect.orDie));
});
