// Dependency-free values shared by every entry point, including the server and Convex ones.

export type LensEnvironmentName = "mainnet" | "testnet"

const LENS_API_ORIGINS: Record<LensEnvironmentName, string> = {
  mainnet: "https://api.lens.xyz",
  testnet: "https://api.testnet.lens.xyz",
}

// Lens signs its tokens as the API origin, and publishes its keys under it.
export function lensApiOrigin(environment: LensEnvironmentName = "mainnet"): string {
  return LENS_API_ORIGINS[environment]
}

export const LENS_CHAIN_IDS: Record<LensEnvironmentName, number> = {
  mainnet: 232,
  testnet: 37111,
}

// Lens access and ID tokens are valid for 10 minutes.
export const LENS_TOKEN_LIFETIME_MS = 10 * 60 * 1000

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// The token the server issues for Convex (server/, convex/, cli/). Both sides must agree on these.
export const DEFAULT_CONVEX_TOKEN_ISSUER = "https://lens-convex-auth.local"
export const DEFAULT_CONVEX_TOKEN_AUDIENCE = "convex"
export const DEFAULT_CONVEX_TOKEN_KEY_ID = "convex-auth-1"
export const DEFAULT_CONVEX_TOKEN_ENDPOINT = "/api/convex-token"
