import { boundedFetch, validateReleaseAssetUrl } from "./download-policy";
import { fetchLatestRelease } from "./release-source";
describe("offline official download policy", () => {
  test.each([
    "http://github.com/TZLXM/FileStation-webservice/releases/download/v1/a",
    "https://evil.test/a",
    "https://github.com/other/repo/releases/download/v1/a",
    "https://user@github.com/TZLXM/FileStation-webservice/releases/download/v1/a",
    "https://github.com/TZLXM/FileStation-webservice/releases/download/v1/a?token=x",
  ])("rejects %s", (u) =>
    expect(() =>
      validateReleaseAssetUrl(u, "TZLXM/FileStation-webservice"),
    ).toThrow(),
  );
  test("bounds bytes and redirects before requesting untrusted host", async () => {
    const f = jest.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/a" },
        }),
    );
    await expect(
      boundedFetch(
        "https://github.com/TZLXM/FileStation-webservice/releases/download/v1/a",
        { fetch: f, maxBytes: 10 },
      ),
    ).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
    await expect(
      boundedFetch(
        "https://github.com/TZLXM/FileStation-webservice/releases/download/v1/a",
        { fetch: async () => new Response("01234567890"), maxBytes: 10 },
      ),
    ).rejects.toThrow();
  });
  test("bounds redirect loops and stalled fetch", async () => {
    const url =
      "https://github.com/TZLXM/FileStation-webservice/releases/download/v1/a";
    await expect(
      boundedFetch(url, {
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: url } }),
        maxBytes: 10,
      }),
    ).rejects.toThrow();
    await expect(
      boundedFetch(url, {
        fetch: () => new Promise(() => {}),
        maxBytes: 10,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
  });
  test("rejects draft/prerelease release before assets", async () => {
    for (const field of ["draft", "prerelease"]) {
      const f = jest.fn(
        async () => new Response(JSON.stringify({ [field]: true })),
      );
      await expect(
        fetchLatestRelease({ fetch: f, trustedKey: undefined as any }),
      ).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
});

test("allows only official CDN redirects and rejects declared/observed response length mismatch", async () => {
  const url =
    "https://github.com/TZLXM/FileStation-webservice/releases/download/v1/a";
  let n = 0;
  const f = jest.fn(async () =>
    ++n === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/asset?sig=fixture",
          },
        })
      : new Response("ok"),
  );
  expect((await boundedFetch(url, { fetch: f, maxBytes: 2 })).toString()).toBe(
    "ok",
  );
  expect(f.mock.calls).toHaveLength(2);
  await expect(
    boundedFetch(url, {
      fetch: async () =>
        new Response("ok", { headers: { "content-length": "1" } }),
      maxBytes: 2,
    }),
  ).rejects.toThrow("mismatch");
});
