import { ConvexError } from "convex/values"
import type { Auth } from "convex/server"
import { ADDRESS_RE, DEFAULT_CONVEX_TOKEN_AUDIENCE, DEFAULT_CONVEX_TOKEN_ISSUER } from "../core/constants"

export type LensAuthProviderOptions = {
  /** Public key from `npx lens-convex-auth keys`. Defaults to process.env.CONVEX_AUTH_JWKS */
  jwks?: string
  /** Must match the server's `issuer` option */
  issuer?: string
  /** Must match the server's `audience` option */
  audience?: string
}

// The auth provider for convex/auth.config.ts. Convex then trusts the tokens your server issues after
// verifying the caller's Lens ID token (createConvexTokenHandler); their subject is the Lens account.
//   export default { providers: [lensAuthProvider({ jwks: process.env.CONVEX_AUTH_JWKS })] }
export function lensAuthProvider(options: LensAuthProviderOptions = {}) {
  const jwks = options.jwks ?? process.env.CONVEX_AUTH_JWKS
  if (!jwks) throw new Error("lens-convex-auth: set CONVEX_AUTH_JWKS on your Convex deployment")
  return {
    type: "customJwt" as const,
    applicationID: options.audience ?? DEFAULT_CONVEX_TOKEN_AUDIENCE,
    issuer: options.issuer ?? DEFAULT_CONVEX_TOKEN_ISSUER,
    jwks,
    algorithm: "RS256" as const,
  }
}

// The Lens account the caller signed in as (lowercased address), or null when signed out.
export async function getLensAccount(ctx: { auth: Auth }): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity()
  const address = identity?.subject
  return address && ADDRESS_RE.test(address) ? address.toLowerCase() : null
}

// Like getLensAccount, but throws a ConvexError when the caller isn't signed in with Lens.
export async function requireLensAccount(ctx: { auth: Auth }, message = "Sign in with Lens to continue"): Promise<string> {
  const account = await getLensAccount(ctx)
  if (!account) throw new ConvexError(message)
  return account
}
