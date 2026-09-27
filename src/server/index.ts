import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose"
import {
  ADDRESS_RE,
  DEFAULT_CONVEX_TOKEN_AUDIENCE,
  DEFAULT_CONVEX_TOKEN_ISSUER,
  DEFAULT_CONVEX_TOKEN_KEY_ID,
  lensApiOrigin,
  type LensEnvironmentName,
} from "../core/constants"

// Convex can't verify Lens ID tokens itself: Lens signs them without a `kid` header, which Convex's
// custom JWT support requires. So the server checks the Lens ID token and exchanges it for a
// short-lived token of its own that Convex trusts (see "lens-convex-auth/convex").

export type LensSession = {
  /** The Lens account the token acts for, lowercased */
  account: string
  /** When the Lens session's ID token expires (seconds since epoch) */
  expiresAt: number
}

export type VerifyLensIdTokenOptions = {
  /** Your Lens app address. Only ID tokens issued to this app are accepted. */
  lensAppAddress: string
  environment?: LensEnvironmentName
  /** Overrides the Lens JWKS (for tests) */
  jwks?: JWTVerifyGetKey
}

export type ConvexTokenOptions = {
  /** PKCS#8 PEM from `npx lens-convex-auth keys`. Defaults to process.env.CONVEX_AUTH_PRIVATE_KEY */
  privateKey?: string
  issuer?: string
  audience?: string
  keyId?: string
}

const lensJwks = new Map<string, JWTVerifyGetKey>()

function lensJwksFor(environment: LensEnvironmentName) {
  let jwks = lensJwks.get(environment)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${lensApiOrigin(environment)}/.well-known/jwks.json`))
    lensJwks.set(environment, jwks)
  }
  return jwks
}

// The Lens account a Lens ID token was issued for. Only ID tokens issued to your app (`aud`) for an
// account (`act.sub`, set for account owners and managers) are accepted; access tokens, onboarding
// sessions and tokens from other Lens apps are rejected.
export async function verifyLensIdToken(idToken: string, options: VerifyLensIdTokenOptions): Promise<LensSession | null> {
  const appAddress = options.lensAppAddress?.toLowerCase()
  if (!appAddress || !ADDRESS_RE.test(appAddress)) throw new Error("lens-convex-auth: lensAppAddress is not set")
  const environment = options.environment ?? "mainnet"
  try {
    const { payload } = await jwtVerify(idToken, options.jwks ?? lensJwksFor(environment), {
      issuer: lensApiOrigin(environment),
    })
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.some((aud) => typeof aud === "string" && aud.toLowerCase() === appAddress)) return null
    const account = (payload.act as { sub?: unknown } | undefined)?.sub
    if (typeof account !== "string" || !ADDRESS_RE.test(account) || !payload.exp) return null
    return { account: account.toLowerCase(), expiresAt: payload.exp }
  } catch {
    return null
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null
}

// The Lens session of a request sent with `auth.fetch` (Authorization: Bearer <Lens ID token>), or null.
// Use it to protect API routes.
export async function getLensSession(request: Request, options: VerifyLensIdTokenOptions): Promise<LensSession | null> {
  const idToken = bearerToken(request)
  return idToken ? verifyLensIdToken(idToken, options) : null
}

const signingKeys = new Map<string, Promise<CryptoKey>>()

function signingKey(pem: string) {
  let key = signingKeys.get(pem)
  if (!key) {
    // Env files and dashboards often store the PEM with escaped newlines
    key = importPKCS8(pem.replace(/\\n/g, "\n"), "RS256").catch((err) => {
      // Retry on the next request (e.g. after the env var is fixed) instead of failing forever
      signingKeys.delete(pem)
      throw err
    })
    signingKeys.set(pem, key)
  }
  return key
}

// A Convex auth token for the account, expiring with the Lens session it came from. Also useful to call
// Convex from the server as the user: `fetchMutation(api.x.y, args, { token })`.
export async function createConvexToken({ account, expiresAt }: LensSession, options: ConvexTokenOptions = {}): Promise<string> {
  const pem = options.privateKey ?? process.env.CONVEX_AUTH_PRIVATE_KEY
  if (!pem) throw new Error("lens-convex-auth: CONVEX_AUTH_PRIVATE_KEY is not set")
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: options.keyId ?? DEFAULT_CONVEX_TOKEN_KEY_ID })
    .setIssuer(options.issuer ?? DEFAULT_CONVEX_TOKEN_ISSUER)
    .setAudience(options.audience ?? DEFAULT_CONVEX_TOKEN_AUDIENCE)
    .setSubject(account)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(await signingKey(pem))
}

// Route handler that exchanges the caller's Lens ID token (Authorization: Bearer) for a Convex token.
// Uses the standard Request/Response, so it works in Next.js route handlers and other runtimes:
//   export const POST = createConvexTokenHandler({ lensAppAddress: process.env.NEXT_PUBLIC_LENS_APP_ADDRESS! })
export function createConvexTokenHandler(options: VerifyLensIdTokenOptions & ConvexTokenOptions) {
  return async function POST(request: Request): Promise<Response> {
    const session = await getLensSession(request, options)
    if (!session) return Response.json({ error: "Invalid Lens ID token" }, { status: 401 })
    return Response.json({ token: await createConvexToken(session, options) }, { headers: { "Cache-Control": "no-store" } })
  }
}

export { DEFAULT_CONVEX_TOKEN_AUDIENCE, DEFAULT_CONVEX_TOKEN_ISSUER, DEFAULT_CONVEX_TOKEN_KEY_ID }
