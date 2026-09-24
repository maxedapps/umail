import {
  makePublicApprovalClient,
  makeUmailClient,
  umailBaseUrl,
} from "@umail/api-contract/client";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { accessToken } from "./auth.ts";

export function umailClient(httpClient: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const baseUrl = yield* umailBaseUrl;
    const token = yield* accessToken();
    return yield* makeUmailClient({ baseUrl, accessToken: token }, httpClient);
  });
}

export function publicApprovalClient(httpClient: HttpClient.HttpClient) {
  return Effect.flatMap(umailBaseUrl, (baseUrl) =>
    makePublicApprovalClient({ baseUrl }, httpClient),
  );
}
