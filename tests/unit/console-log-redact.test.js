import { describe, expect, it } from "vitest";
import { redactConsoleLogSecrets, redactConsoleLogLines } from "../../src/lib/consoleLogRedact.js";
import { formatConsoleLogLine } from "../../src/lib/consoleLogBuffer.js";

describe("redactConsoleLogSecrets", () => {
  it("redacts Bearer tokens and Authorization headers", () => {
    expect(redactConsoleLogSecrets("Authorization: Bearer sk-live-abcdefghijklmnop"))
      .toBe("Authorization: Bearer ***");
    expect(redactConsoleLogSecrets("Bearer abcdefghijklmnop"))
      .toBe("Bearer ***");
    expect(redactConsoleLogSecrets("Authorization: supersecrettokenvalue"))
      .toBe("Authorization: ***");
  });

  it("redacts long sk- / sk_ keys but keeps sk_9router", () => {
    expect(redactConsoleLogSecrets("key=sk-abcdefghijklmnopqrst")).toContain("sk-***");
    expect(redactConsoleLogSecrets("key=sk_stored_apply_secret_value")).toContain("sk_***");
    expect(redactConsoleLogSecrets("using sk_9router locally")).toContain("sk_9router");
  });

  it("redacts JWT-looking strings and api_key fields", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.signaturepart";
    expect(redactConsoleLogSecrets(`token ${jwt}`)).not.toContain("eyJhbGci");
    expect(redactConsoleLogSecrets('api_key = "supersecretvalue"')).toBe('api_key = "***"');
    expect(redactConsoleLogSecrets('{"apiKey":"supersecretvalue"}')).toContain("***");
  });

  it("redacts cli token header values", () => {
    expect(redactConsoleLogSecrets("x-9r-cli-token: deadbeefcafebabe")).toBe(
      "x-9r-cli-token: ***"
    );
  });
});

describe("formatConsoleLogLine secret redaction", () => {
  it("redacts secrets when capturing console lines", () => {
    const line = formatConsoleLogLine(
      "info",
      ["auth Authorization: Bearer sk-live-abcdefghijklmnop"],
      { formatTime: () => "12:00:00" }
    );
    expect(line).toBe("[12:00:00] [INFO] auth Authorization: Bearer ***");
    expect(line).not.toContain("sk-live");
  });

  it("is idempotent and maps arrays", () => {
    const once = redactConsoleLogSecrets("Bearer sk-live-abcdefghijklmnop");
    expect(redactConsoleLogSecrets(once)).toBe(once);
    expect(redactConsoleLogLines([
      "Authorization: Bearer sk-live-abcdefghijklmnop",
      "using sk_9router",
    ])).toEqual([
      "Authorization: Bearer ***",
      "using sk_9router",
    ]);
  });
});
