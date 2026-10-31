export const OFFICIAL_REPOSITORY = "TZLXM/FileStation-webservice";
export type Fetch = typeof globalThis.fetch;
export function validateReleaseAssetUrl(
  value: string,
  expectedRepository = OFFICIAL_REPOSITORY,
): URL {
  if (expectedRepository !== OFFICIAL_REPOSITORY)
    throw new Error("Unofficial repository");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !new RegExp(`^/${expectedRepository}/releases/download/[^/]+/[^/]+$`).test(
      u.pathname,
    ) ||
    /%|\\/.test(value)
  )
    throw new Error("Untrusted release asset URL");
  return u;
}
const API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases/latest`;
function permitted(u: URL, initial: URL): boolean {
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash)
    return false;
  if (initial.href === API) return u.href === API;
  if (u.hostname === "github.com") {
    try {
      validateReleaseAssetUrl(u.href);
      return true;
    } catch {
      return false;
    }
  }
  // Official asset CDN redirects have query signatures; never send credentials there.
  return (
    [
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(u.hostname) && u.pathname.startsWith("/")
  );
}
export async function boundedFetch(
  url: string,
  options: {
    fetch?: Fetch;
    maxBytes: number;
    timeoutMs?: number;
    maxRedirects?: number;
  },
): Promise<Buffer> {
  const initial = new URL(url);
  if (url !== API) validateReleaseAssetUrl(url);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new Error("Invalid response budget");
  const timeout = options.timeoutMs ?? 15000;
  const redirects = options.maxRedirects ?? 3;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 120000 ||
    !Number.isInteger(redirects) ||
    redirects < 0 ||
    redirects > 5
  )
    throw new Error("Invalid request budget");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Release request timed out"));
    }, timeout);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const work = async () => {
    let next = initial;
    for (let count = 0; ; count++) {
      if (!permitted(next, initial) || controller.signal.aborted)
        throw new Error("Untrusted redirect");
      const response = await (options.fetch ?? globalThis.fetch)(next.href, {
        redirect: "manual",
        signal: controller.signal,
        credentials: "omit",
        headers: {
          Accept:
            next.href === API
              ? "application/vnd.github+json"
              : "application/octet-stream",
        },
      });
      if (controller.signal.aborted) {
        await response.body?.cancel();
        throw new Error("Request aborted");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || count >= redirects) throw new Error("Redirect limit");
        next = new URL(location, next);
        continue;
      }
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== next.href)
      ) {
        await response.body?.cancel();
        throw new Error("Unexpected release response");
      }
      const declared = response.headers.get("content-length");
      if (
        declared &&
        (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes)
      ) {
        await response.body?.cancel();
        throw new Error("Response size limit");
      }
      if (!response.body) throw new Error("Empty release response");
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > options.maxBytes) throw new Error("Response size limit");
        chunks.push(Buffer.from(value));
      }
      if (declared && size !== Number(declared))
        throw new Error("Response size mismatch");
      return Buffer.concat(chunks, size);
    }
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
export const OFFICIAL_RELEASE_API = API;
