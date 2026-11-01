/**
 * Fixed Ed25519 publisher trust root (base64 SPKI).
 *
 * The publisher public key is provisioned here and included in release
 * artifacts. The matching private key belongs only to the protected signing
 * environment. Runtime configuration and downloaded metadata may never
 * replace this value.
 */
export const UPDATE_PUBLIC_KEY_STATUS: "unconfigured" | "configured" =
  "configured";
export const UPDATE_PUBLIC_KEY_SPKI_BASE64: string = "MCowBQYDK2VwAyEAdaUOV1VQCQ9rzi4Vv8dD4GaYSr9rCY7liG/CuZcp780=";

export function getUpdatePublicKeySpkiBase64(): string | null {
  return UPDATE_PUBLIC_KEY_STATUS === "unconfigured"
    ? null
    : UPDATE_PUBLIC_KEY_SPKI_BASE64;
}
