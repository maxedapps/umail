import { describe, expect, it } from "vitest";

import { readBoundedRequestBody, verifyControlToken } from "./mail-capacity-host.ts";

describe("mail capacity host guards", () => {
  it("accepts exactly the byte limit and rejects the next streamed byte", async () => {
    const atLimit = await readBoundedRequestBody(postRequest("abcd"), 4);
    const overLimit = await readBoundedRequestBody(postRequest("abcde"), 4);

    expect(atLimit).toEqual({
      kind: "bytes",
      bytes: new TextEncoder().encode("abcd"),
    });
    expect(overLimit).toEqual({ kind: "too_large" });
  });

  it("rejects a declared oversized body before accepting its smaller payload", async () => {
    const request = postRequest("x", "5");

    await expect(readBoundedRequestBody(request, 4)).resolves.toEqual({
      kind: "too_large",
    });
  });

  it("accepts only the complete bearer control token", async () => {
    const token = "capacity-control-token-with-32-bytes";

    await expect(verifyControlToken(`Bearer ${token}`, token)).resolves.toBe(true);
    await expect(verifyControlToken(`Bearer ${token}x`, token)).resolves.toBe(false);
    await expect(verifyControlToken(null, token)).resolves.toBe(false);
    await expect(verifyControlToken(token, token)).resolves.toBe(false);
  });
});

function postRequest(body: string, contentLength?: string): Request {
  const init: RequestInit = { method: "POST", body };
  if (contentLength !== undefined) {
    init.headers = new Headers({ "content-length": contentLength });
  }
  return new Request("https://capacity.invalid/seed", init);
}
