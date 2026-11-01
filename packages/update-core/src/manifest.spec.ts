import { generateKeyPairSync, sign } from "node:crypto";
import { verifyManifest, selectUpdate } from "./manifest";
import canonicalize from "canonicalize";
export const keys = generateKeyPairSync("ed25519");
import { manifestFixture as fixture } from "./test-fixture";
const verified = (m = fixture()) => {
  const b = Buffer.from(canonicalize(m)!);
  return verifyManifest(b, sign(null, b, keys.privateKey), keys.publicKey);
};
describe("signed manifest and decisions", () => {
  test.each([
    ["commit", ["a".repeat(40)]],
    ["migration_workspace_multiplier", 1.99],
    ["migration_workspace_multiplier", 64.01],
    ["migration_workspace_min_bytes", 268435455],
    ["minimum_node", "20.16.0"],
    ["release_summaries", { "zh-CN": {}, en: {} }],
  ])("rejects strict field boundary %s", (k, v) => {
    const m = fixture();
    m[k as string] = v;
    expect(() => verified(m)).toThrow();
  });
  test("rejects invalid Unicode and unsafe JSON numeric values", () => {
    const m = fixture();
    m.release_summaries.en.fixes[0].text = "\ud800";
    expect(() => verified(m)).toThrow();
    const b = Buffer.from(
      canonicalize(fixture())!.replace("268435456", "9007199254740992"),
    );
    expect(() =>
      verifyManifest(b, sign(null, b, keys.privateKey), keys.publicKey),
    ).toThrow();
  });
  test("accepts boundary migration values and migration-free zero fields", () => {
    for (const n of [2, 64]) {
      const m = fixture();
      m.migration_workspace_multiplier = n;
      expect(verified(m).migration_workspace_multiplier).toBe(n);
    }
    const m = fixture();
    m.database_migration = false;
    m.migration_workspace_multiplier = 0;
    m.migration_workspace_min_bytes = 0;
    expect(verified(m).database_migration).toBe(false);
  });
  test("rejects prerelease installed version and unverified manifest", () => {
    expect(
      selectUpdate(verified(), "0.2.0-rc.1", "win32", "x64", "0.2.0").status,
    ).toBe("invalid_version");
    expect(() =>
      selectUpdate(fixture(), "0.2.0", "win32", "x64", "0.2.0"),
    ).toThrow();
  });
  test("accepts canonical signed manifest with explicit trusted key", () =>
    expect(verified().version).toBe("0.2.5"));
  test("rejects tampering, whitespace, duplicate keys and wrong key", () => {
    const b = Buffer.from(canonicalize(fixture())!);
    const s = sign(null, b, keys.privateKey);
    for (const x of [
      Buffer.from(" " + b),
      Buffer.from(b.toString().replace("0.2.5", "0.2.6")),
      Buffer.from(
        b.toString().replace('"version":', '"version":"0.2.5","version":'),
      ),
    ])
      expect(() => verifyManifest(x, s, keys.publicKey)).toThrow();
    expect(() =>
      verifyManifest(b, s, generateKeyPairSync("ed25519").publicKey),
    ).toThrow();
  });
  test.each([
    ["unknown", true],
    ["update_protocol", 2],
    ["version", "0.2.5-rc.1"],
    ["version", "v0.2.5"],
    ["migration_workspace_multiplier", 0],
    ["migration_workspace_multiplier", 101],
    ["migration_workspace_min_bytes", -1],
    ["migration_workspace_min_bytes", Number.MAX_SAFE_INTEGER + 1],
    ["channel", "beta"],
    ["minimum_node", "20"],
    ["commit", "abc"],
  ])("rejects invalid %s=%s", (k, v) => {
    const m = fixture();
    m[k as string] = v;
    expect(() => verified(m)).toThrow();
  });
  test("rejects nested unknown fields, bad artifact numbers and summaries", () => {
    for (const change of [
      (m: any) => (m.artifacts[0].extra = true),
      (m: any) => (m.artifacts[0].archive_size = 0),
      (m: any) => (m.artifacts[0].unpacked_size = 1.2),
      (m: any) => (m.release_summaries.en.other = []),
    ]) {
      const m = fixture();
      change(m);
      expect(() => verified(m)).toThrow();
    }
  });
  test.each([
    ["0.2.0", "win32", "x64", "0.2.0", "22.0.0", "available"],
    ["0.2.5", "win32", "x64", "0.2.0", "22.0.0", "same_version"],
    ["0.3.0", "win32", "x64", "0.2.0", "22.0.0", "downgrade"],
    ["0.2.0", "linux", "arm64", "0.2.0", "22.0.0", "unsupported_platform"],
    ["0.2.0", "win32", "x64", "0.1.0", "22.0.0", "updater_required"],
    ["0.2.0", "win32", "x64", "0.2.0", "18.0.0", "node_required"],
  ])("selects %s/%s/%s/%s/%s", (v, p, a, u, n, r) =>
    expect(selectUpdate(verified(), v, p, a, u, n).status).toBe(r),
  );
  test("requires bootstrap and compatible source version", () => {
    const m = fixture();
    m.requires_manual_bootstrap = true;
    expect(
      selectUpdate(verified(m), "0.2.0", "win32", "x64", "0.2.0").status,
    ).toBe("manual_bootstrap");
    m.requires_manual_bootstrap = false;
    m.automatic_update_from = "0.2.4";
    expect(
      selectUpdate(verified(m), "0.2.0", "win32", "x64", "0.2.0").status,
    ).toBe("manual_bootstrap");
  });
});

test("rejects signed UTF8 BOM and invalid calendar timestamp", () => {
  const b = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(canonicalize(fixture())!),
  ]);
  expect(() =>
    verifyManifest(b, sign(null, b, keys.privateKey), keys.publicKey),
  ).toThrow();
  const m = fixture();
  m.published_at = "2026-02-31T00:00:00.000Z";
  const c = Buffer.from(canonicalize(m)!);
  expect(() =>
    verifyManifest(c, sign(null, c, keys.privateKey), keys.publicKey),
  ).toThrow();
});
