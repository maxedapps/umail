import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";

// Effect's crypto services, which the server provides over WebCrypto: both workerd and Node have it.
export type Crypto = SecureRandom.SecureRandom | Digest.Digest;

export const WebCrypto = Layer.merge(SecureRandom.layerWebCrypto, Digest.layerWebCrypto);

export const randomId = SecureRandom.SecureRandom.use((random) => random.uuidV4());

export const sha256Hex = (bytes: Uint8Array) =>
  Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, bytes));
