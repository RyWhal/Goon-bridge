import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeJsonStrings,
  sanitizePostgresText,
} from "../src/lib/unicode-safety.ts";

test("sanitizePostgresText removes null bytes and lone surrogates", () => {
  assert.equal(
    sanitizePostgresText(`ok\u0000bad\uD800mid\uDC00end`),
    "okbad mid end"
  );
});

test("sanitizeJsonStrings recursively cleans string values", () => {
  assert.deepEqual(
    sanitizeJsonStrings({
      message: "bad\uD800value",
      nested: ["ok", "also\u0000bad"],
    }),
    {
      message: "bad value",
      nested: ["ok", "alsobad"],
    }
  );
});
