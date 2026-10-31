import { generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { fetchLatestRelease } from "./release-source";
import { OFFICIAL_RELEASE_API } from "./download-policy";
// Fixture is intentionally local: no fetch implementation in these tests performs I/O.
import { manifestFixture } from "./test-fixture";
test("loads official publisher manifest/signature names through injected fetch and rejects tampered signature", async () => {
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(canonicalize(manifestFixture())!);
  const signature = sign(null, bytes, keys.privateKey);
  const base =
    "https://github.com/TZLXM/FileStation-webservice/releases/download/v0.2.5/";
  const release = {
    tag_name: "v0.2.5",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "update-manifest.json",
        browser_download_url: base + "update-manifest.json",
      },
      {
        name: "update-manifest.json.sig",
        browser_download_url: base + "update-manifest.json.sig",
      },
    ],
  };
  const f = jest.fn(async (url: any) =>
    url === OFFICIAL_RELEASE_API
      ? new Response(JSON.stringify(release))
      : new Response(url.endsWith(".sig") ? signature : bytes),
  );
  expect(
    (await fetchLatestRelease({ fetch: f, trustedKey: keys.publicKey }))
      .version,
  ).toBe("0.2.5");
  expect(f).toHaveBeenCalledTimes(3);
  signature[0] ^= 1;
  await expect(
    fetchLatestRelease({ fetch: f, trustedKey: keys.publicKey }),
  ).rejects.toThrow("signature");
});
