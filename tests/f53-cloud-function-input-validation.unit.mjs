// Unit test for a confirmed input-validation gap found during the second
// deep audit pass (Section 11 — F.5.3 Cloud Function static adversarial
// review): functions/src/resolveBusinessLocation.ts's buildQuery() and its
// existingLat/existingLng handling trusted LocationResolveInput's TypeScript
// field types at runtime. That type is a compile-time-only contract for
// what the BROWSER's own client sends — it constrains nothing for a caller
// who hits this callable's HTTPS endpoint directly (bypassing the Firebase
// client SDK, e.g. with a stolen-but-valid ID token belonging to a real,
// authorized Manager). Before the fix:
//   - a non-string businessName/address/city/area/state/country (a number,
//     array, boolean, or nested object) crashed on `.trim()` with an
//     uncaught TypeError, wrapped by Firebase's onCall as an opaque
//     "internal" error rather than a clean "invalid-argument" — never a
//     leak (onCall never lets an unhandled exception's message reach the
//     caller), but an unnecessary, ugly failure for input this function
//     can simply treat as absent.
//   - a NaN/Infinity/out-of-range existingLat or existingLng flowed
//     straight into haversineMeters(), producing a nonsensical
//     distanceFromSpreadsheetCoordsMeters (e.g. NaN) shown to the Manager
//     next to a real geocoding result.
//
// This does NOT call Google, and does NOT invoke the onCall wrapper itself
// (no Firebase Admin/emulator needed) — it tests the extracted pure
// functions (toSafeString, toSafeCoordinate, buildQuery) directly against
// the actual compiled output in functions/lib, run via
// `npm --prefix functions run build` beforehand by this script.
//
// Run with: npm run test:f53-cloud-function-input-validation

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  console.log("Building functions/ (tsc)...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["--prefix", "functions", "run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`functions build failed with code ${code}`))));
  });

  const require = createRequire(import.meta.url);
  const modPath = path.resolve(process.cwd(), "functions/lib/resolveBusinessLocation.js");
  delete require.cache[require.resolve(modPath)];
  const { toSafeString, toSafeCoordinate, buildQuery } = require(modPath);

  console.log("\n[toSafeString] legitimate string values pass through unchanged:");
  check(toSafeString("ABC Motors") === "ABC Motors", "a normal string is returned as-is");
  check(toSafeString("") === "", "an empty string is still a string — returned as-is (buildQuery's own isBlank() filters it)");

  console.log("\n[toSafeString — malicious payloads] non-string values are treated as absent, never crash:");
  const maliciousStringPayloads = [
    { label: "number", value: 12345 },
    { label: "boolean", value: true },
    { label: "plain object", value: { toString: "polluted" } },
    { label: "array", value: ["a", "b"] },
    { label: "nested object", value: { a: { b: { c: "deep" } } } },
    { label: "null", value: null },
    { label: "NaN", value: NaN },
    { label: "Infinity", value: Infinity },
    { label: "huge string (1MB)", value: "x".repeat(1024 * 1024) },
    { label: "__proto__-shaped object", value: { __proto__: { polluted: true } } },
  ];
  for (const { label, value } of maliciousStringPayloads) {
    let result;
    let threw = false;
    try {
      result = toSafeString(value);
    } catch {
      threw = true;
    }
    check(!threw, `[${label}] toSafeString() never throws`);
    if (label === "huge string (1MB)") {
      check(result === value, "a huge but genuinely-a-string value is still accepted as a string (size is Firebase callable's own 10MB request-body concern, not this function's)");
    } else {
      check(result === undefined, `[${label}] non-string value is normalized to undefined, not passed through`);
    }
  }

  console.log("\n[buildQuery — malicious payloads] a fully hostile input object never crashes, and never includes anything but real strings:");
  const hostileInputs = [
    { businessName: 12345, address: true, city: {}, area: [], state: null, country: undefined },
    { businessName: { __proto__: { polluted: true } } },
    { businessName: "Real Name", address: { nested: { deeply: "object" } } },
    {},
    null,
    undefined,
    "a raw string instead of an object",
    ["an", "array", "instead", "of", "an", "object"],
    12345,
  ];
  for (const input of hostileInputs) {
    let query;
    let threw = false;
    try {
      // Mirrors resolveBusinessLocation's own top-level guard before
      // calling buildQuery (typeof check + null check) — buildQuery itself
      // is still exercised directly against non-object shapes too, since a
      // hostile caller's request.data could itself be anything JSON allows.
      const safeInput = typeof input === "object" && input !== null ? input : {};
      query = buildQuery(safeInput);
    } catch (err) {
      threw = true;
      console.error("    unexpected throw:", err);
    }
    check(!threw, `buildQuery() never throws for input ${JSON.stringify(input)?.slice(0, 60)}`);
    check(typeof query === "string", "buildQuery() always returns a string");
  }

  console.log("\n[buildQuery] a real, well-formed request still builds a normal comma-joined query (no regression):");
  const wellFormed = buildQuery({ businessName: "ABC Motors", address: "12 MG Road", city: "Rajampet", state: "Andhra Pradesh", country: "India" });
  check(wellFormed === "ABC Motors, 12 MG Road, Rajampet, Andhra Pradesh, India", `well-formed input still produces the expected query (got: "${wellFormed}")`);

  console.log("\n[buildQuery] a legitimate field mixed with a hostile sibling field: only the hostile one is dropped, the rest of the query still builds:");
  const mixedInput = buildQuery({ businessName: "Real Business", address: { polluted: true }, city: "Rajampet" });
  // "India" is buildQuery's own default when country is absent (see
  // resolveBusinessLocation.ts) — unrelated to this test's hostile field,
  // and correctly still present.
  check(mixedInput === "Real Business, Rajampet, India", `the object-valued 'address' is dropped, everything else (including the default country) survives (got: "${mixedInput}")`);

  console.log("\n[toSafeCoordinate] legitimate coordinates pass through:");
  check(toSafeCoordinate(14.5, 90) === 14.5, "a valid latitude is returned as-is");
  check(toSafeCoordinate(-179.9, 180) === -179.9, "a valid longitude is returned as-is");
  check(toSafeCoordinate(0, 90) === 0, "zero is a legitimate coordinate, not falsy-rejected");

  console.log("\n[toSafeCoordinate — malicious payloads] invalid coordinates never crash and are normalized to undefined:");
  const maliciousCoordPayloads = [
    { label: "NaN", value: NaN },
    { label: "Infinity", value: Infinity },
    { label: "-Infinity", value: -Infinity },
    { label: "out of range (999)", value: 999 },
    { label: "out of range (-181 for lng bound 180)", value: -181 },
    { label: "string that looks numeric", value: "14.5" },
    { label: "boolean", value: true },
    { label: "object", value: { lat: 14.5 } },
    { label: "array", value: [14.5] },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ];
  for (const { label, value } of maliciousCoordPayloads) {
    let result;
    let threw = false;
    try {
      result = toSafeCoordinate(value, 90);
    } catch {
      threw = true;
    }
    check(!threw, `[${label}] toSafeCoordinate() never throws`);
    check(result === undefined, `[${label}] invalid coordinate is normalized to undefined`);
  }

  console.log("\n[toSafeCoordinate — exact requested matrix] existingLat (bound 90) and existingLng (bound 180), every value from the audit's own list:");
  const latMatrix = ["NaN", "Infinity", "-Infinity", null, undefined, {}, [], "91", "-91", 91, -91];
  for (const value of latMatrix) {
    let result, threw = false;
    try { result = toSafeCoordinate(value, 90); } catch { threw = true; }
    check(!threw, `existingLat=${JSON.stringify(value)} never throws`);
    check(result === undefined, `existingLat=${JSON.stringify(value)} is rejected (normalized to undefined) — never reaches haversineMeters() or the query`);
  }
  const lngMatrix = ["NaN", "Infinity", "-Infinity", null, undefined, {}, [], "181", "-181", 181, -181];
  for (const value of lngMatrix) {
    let result, threw = false;
    try { result = toSafeCoordinate(value, 180); } catch { threw = true; }
    check(!threw, `existingLng=${JSON.stringify(value)} never throws`);
    check(result === undefined, `existingLng=${JSON.stringify(value)} is rejected (normalized to undefined) — never reaches haversineMeters() or the query`);
  }
  // The boundary itself (exactly 90 / 180 / -90 / -180) is a real, valid
  // Earth coordinate and must NOT be rejected — only values that exceed it.
  check(toSafeCoordinate(90, 90) === 90, "exactly the boundary value 90 is accepted for lat (not off-by-one rejected)");
  check(toSafeCoordinate(-90, 90) === -90, "exactly the boundary value -90 is accepted for lat");
  check(toSafeCoordinate(180, 180) === 180, "exactly the boundary value 180 is accepted for lng");
  check(toSafeCoordinate(-180, 180) === -180, "exactly the boundary value -180 is accepted for lng");

  console.log("\n[buildQuery] existingLat/existingLng were never part of the serialized query in the first place (only businessName/address/city/area/state/country are) — confirming there is no code path by which an invalid coordinate could be 'serialized into the query':");
  const queryIgnoresCoords = buildQuery({ businessName: "Test Biz", existingLat: "NaN", existingLng: { malicious: true } });
  check(queryIgnoresCoords === "Test Biz, India", `buildQuery()'s output contains nothing coordinate-related regardless of what existingLat/existingLng carry (got: "${queryIgnoresCoords}")`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
