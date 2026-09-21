import {
  configFromEnvironment,
  makePublicApprovalClient,
  makeUmailClient,
  publicApprovalConfigFromEnvironment,
  type PublicApprovalClientEnvironment,
  type UmailClientEnvironment,
} from "@umail/api-contract/client";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { accessToken } from "./auth.ts";

export function clientFromEnv(env: UmailClientEnvironment, httpClient: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const { baseUrl } = yield* configFromEnvironment(env);
    const token = yield* accessToken(env);
    return yield* makeUmailClient({ baseUrl, accessToken: token }, httpClient);
  });
}

export function publicApprovalClientFromEnv(
  env: PublicApprovalClientEnvironment,
  httpClient: HttpClient.HttpClient,
) {
  return Effect.flatMap(publicApprovalConfigFromEnvironment(env), (config) =>
    makePublicApprovalClient(config, httpClient),
  );
}
