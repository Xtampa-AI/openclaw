import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./index.js";

const ENV_KEY = "KAIROS_WAKE_BRIDGE_TOKEN";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("Kairos-Wake bridge credential resolution", () => {
  it("uses the process environment when authToken is omitted", () => {
    process.env[ENV_KEY] = "kwoc_from_environment";
    expect(resolveConfig({}).authToken).toBe("kwoc_from_environment");
  });

  it("prefers a resolved SecretRef value over the environment", () => {
    process.env[ENV_KEY] = "kwoc_from_environment";
    expect(resolveConfig({ authToken: "kwoc_from_secret_ref" }).authToken).toBe(
      "kwoc_from_secret_ref",
    );
  });

  it("fails closed when an explicit SecretRef is unresolved", () => {
    process.env[ENV_KEY] = "kwoc_from_environment";
    expect(
      resolveConfig({
        authToken: { source: "store", provider: "vault", id: "openclaw/wake" },
      }).authToken,
    ).toBeUndefined();
  });
});
