import {
  OrbAppsSDK,
  OrbAuthUnavailableError,
  ORB_SANDBOX_REQUESTOR_DOMAIN,
  isCompactJwt,
  verifyOrbAccessToken,
} from "@orbclub/apps-sdk"
import { createConvexToken, type ConvexTokenOptions, type LensSession } from "../server"

export { OrbAuthUnavailableError }

export type VerifyOrbSessionOptions = {
  /**
   * Accept tokens Orb issued to apps running inside Orb. Defaults to true. These tokens all carry Orb's own
   * Lens app and no domain, so they don't show which Orb app got them: anyone running another Orb app could
   * send your server the tokens its viewers gave it. See "Security" in the README.
   */
  acceptOrbApp?: boolean
  /**
   * Accept tokens from the Orb sandbox (https://orb-apps.vercel.app/sandbox), which hands every app it
   * frames the visitor's own sign-in. For local development only, e.g. `process.env.NODE_ENV === "development"`.
   */
  allowSandbox?: boolean
  /** How long to wait for Orb to answer, in ms. Defaults to 5000. */
  timeoutMs?: number
  /** The Orb SDK instance to verify with (for tests, or a self-hosted Orb API) */
  sdk?: OrbAppsSDK
}

let defaultSdk: OrbAppsSDK | undefined

// The Lens account an Orb access token acts for, or null when Orb refuses it (expired, revoked, issued to
// a site this server doesn't accept). Asks Orb every time: there's no cache. Throws OrbAuthUnavailableError
// when Orb can't be reached, which isn't a sign-out: answer 503 and let the client try again.
export async function verifyOrbSession(accessToken: string, options: VerifyOrbSessionOptions = {}): Promise<LensSession | null> {
  if (!isCompactJwt(accessToken)) return null
  const sdk = options.sdk ?? (defaultSdk ??= new OrbAppsSDK())
  const result = await verifyOrbAccessToken(sdk, accessToken, {
    requestorDomains: options.allowSandbox ? [ORB_SANDBOX_REQUESTOR_DOMAIN] : [],
    acceptOrbApp: options.acceptOrbApp ?? true,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  })
  if (result.status !== "verified") return null
  const expiresAt = Math.floor(Date.parse(result.session.expiresAt) / 1000)
  return { account: result.session.address.toLowerCase(), expiresAt }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null
}

// The Orb session of a request sent with `orb.fetch` (Authorization: Bearer <Orb access token>), or null.
// Use it to protect API routes. Throws OrbAuthUnavailableError like verifyOrbSession.
export async function getOrbSession(request: Request, options: VerifyOrbSessionOptions = {}): Promise<LensSession | null> {
  const accessToken = bearerToken(request)
  return accessToken ? verifyOrbSession(accessToken, options) : null
}

const noStore = { "Cache-Control": "no-store" }

// Route handler that exchanges the caller's Orb access token (Authorization: Bearer) for a Convex token for
// the same Lens account, so Convex functions see Orb viewers like any other (requireLensAccount(ctx)).
//   export const POST = createOrbConvexTokenHandler()
export function createOrbConvexTokenHandler(options: VerifyOrbSessionOptions & ConvexTokenOptions = {}) {
  return async function POST(request: Request): Promise<Response> {
    let session: LensSession | null
    try {
      session = await getOrbSession(request, options)
    } catch (err) {
      if (err instanceof OrbAuthUnavailableError) {
        return Response.json({ error: "Orb is unavailable" }, { status: 503, headers: noStore })
      }
      throw err
    }
    if (!session) return Response.json({ error: "Invalid Orb access token" }, { status: 401, headers: noStore })
    return Response.json({ token: await createConvexToken(session, options) }, { headers: noStore })
  }
}
