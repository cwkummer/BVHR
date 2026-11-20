import { describe, expect, test } from "bun:test";
import { MIN_JWT_SECRET_LENGTH, requireGoogleClientId, requireJwtSecret } from "../config";

describe("required configuration", () => {
  test("JWT_SECRET must exist and be at least 32 characters", () => {
    expect(MIN_JWT_SECRET_LENGTH).toBe(32);
    expect(() => requireJwtSecret({})).toThrow("JWT_SECRET");
    expect(() => requireJwtSecret({ JWT_SECRET: "" })).toThrow();
    expect(() => requireJwtSecret({ JWT_SECRET: "short" })).toThrow();
    expect(() => requireJwtSecret({ JWT_SECRET: "12345678" })).toThrow(); // the old minimum
    expect(() => requireJwtSecret({ JWT_SECRET: "x".repeat(31) })).toThrow();
    expect(requireJwtSecret({ JWT_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
  });

  test("surrounding whitespace does not count toward the length and is trimmed", () => {
    expect(() => requireJwtSecret({ JWT_SECRET: `  ${"x".repeat(20)}  ` })).toThrow();
    expect(requireJwtSecret({ JWT_SECRET: `\n${"y".repeat(40)} ` })).toBe("y".repeat(40));
  });

  test("GOOGLE_CLIENT_ID must exist and is trimmed", () => {
    expect(() => requireGoogleClientId({})).toThrow("GOOGLE_CLIENT_ID");
    expect(() => requireGoogleClientId({ GOOGLE_CLIENT_ID: "   " })).toThrow();
    expect(requireGoogleClientId({ GOOGLE_CLIENT_ID: " abc.apps.googleusercontent.com " })).toBe("abc.apps.googleusercontent.com");
  });
});
