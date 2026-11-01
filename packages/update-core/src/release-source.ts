import { KeyObject } from "node:crypto";
import {
  boundedFetch,
  Fetch,
  OFFICIAL_RELEASE_API,
  validateReleaseAssetUrl,
} from "./download-policy";
import { verifyManifest, VerifiedManifestV1 } from "./manifest";
export async function fetchLatestRelease(options: {
  fetch?: Fetch;
  trustedKey: KeyObject;
}): Promise<VerifiedManifestV1> {
  const release = JSON.parse(
    (
      await boundedFetch(OFFICIAL_RELEASE_API, {
        fetch: options.fetch,
        maxBytes: 1024 * 1024,
      })
    ).toString("utf8"),
  );
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    !Array.isArray(release.assets) ||
    release.assets.length > 100
  )
    throw new Error("Invalid stable release");
  const asset = (name: string) => {
    const matches = release.assets.filter((a: any) => a.name === name);
    if (matches.length !== 1)
      throw new Error("Missing/duplicate manifest asset");
    const url = validateReleaseAssetUrl(matches[0].browser_download_url);
    if (
      typeof release.tag_name !== "string" ||
      url.pathname.split("/")[5] !== release.tag_name
    )
      throw new Error("Release tag mismatch");
    return url.href;
  };
  const bytes = await boundedFetch(asset("update-manifest.json"), {
    fetch: options.fetch,
    maxBytes: 1024 * 1024,
  });
  const signature = await boundedFetch(asset("update-manifest.json.sig"), {
    fetch: options.fetch,
    maxBytes: 64,
  });
  const manifest = verifyManifest(bytes, signature, options.trustedKey);
  if (`v${manifest.version}` !== release.tag_name)
    throw new Error("Signed release version mismatch");
  return manifest;
}
