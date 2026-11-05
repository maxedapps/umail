import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

// The Node services every command runs on.
export const CliPlatform = Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom);
