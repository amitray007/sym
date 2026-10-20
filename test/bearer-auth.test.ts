import { afterEach, describe, expect, it } from "vitest";
import { bearerToken } from "../lib/bearer-auth.ts";

const auth = bearerToken({
  variable: "SYM_TEST_TOKEN",
  authenticator: "sym-test-token",
  principalId: "sym-test",
});

const request = (authorization?: string) =>
  new Request("http://localhost/eve/v1/session", {
    headers: authorization ? { authorization } : {},
  });

describe("bearerToken", () => {
  afterEach(() => {
    delete process.env.SYM_TEST_TOKEN;
  });

  it("accepts the configured token as a service caller", async () => {
    process.env.SYM_TEST_TOKEN = "secret-value";
    expect(await auth(request("Bearer secret-value"))).toEqual({
      attributes: {},
      authenticator: "sym-test-token",
      principalId: "sym-test",
      principalType: "service",
    });
  });

  it("rejects a wrong token, a prefix of the token, and no token", async () => {
    process.env.SYM_TEST_TOKEN = "secret-value";
    expect(await auth(request("Bearer secret-valuX"))).toBeNull();
    expect(await auth(request("Bearer secret"))).toBeNull();
    expect(await auth(request())).toBeNull();
  });

  it("accepts nothing when the variable is unset", async () => {
    expect(await auth(request("Bearer "))).toBeNull();
    expect(await auth(request("Bearer anything"))).toBeNull();
  });
});
