/**
 * Fixed Ed25519 publisher trust root (base64 SPKI).
 *
 * This repository intentionally ships without a publisher key. Release
 * signing and verification must fail closed until a reviewed key is
 * provisioned here. Runtime configuration and downloaded metadata may never
 * replace this value.
 */
export const UPDATE_PUBLIC_KEY_STATUS: "unconfigured" | "configured" =
  "unconfigured";
export const UPDATE_PUBLIC_KEY_SPKI_BASE64: string = "UNCONFIGURED";

export function getUpdatePublicKeySpkiBase64(): string | null {
  return UPDATE_PUBLIC_KEY_STATUS === "unconfigured"
    ? null
    : UPDATE_PUBLIC_KEY_SPKI_BASE64;
}
