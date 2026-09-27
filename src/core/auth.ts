import { PublicClient, evmAddress, mainnet, signatureFrom, testnet, type SessionClient, type UUID } from "@lens-protocol/client"
import { createThirdwebClient, type ThirdwebClient } from "thirdweb"
import type { Chain } from "thirdweb/chains"
import type { Chain as ViemChain } from "viem"
import { ADDRESS_RE, DEFAULT_CONVEX_TOKEN_ENDPOINT, lensApiOrigin, type LensEnvironmentName } from "./constants"
import { lensSessionFromIdToken } from "./jwt"
import { LensTokenStorage } from "./storage"
import { TokenService, type LensCredentials } from "./tokens"
import { lensThirdwebChain, lensViemChain } from "./wallet"

export type LensAuthOptions = {
  /** thirdweb client ID (https://thirdweb.com/dashboard) */
  thirdwebClientId: string
  /** Your Lens app address (https://developer.lens.xyz/apps). Tokens are issued for this app. */
  lensAppAddress: string
  /** Defaults to "mainnet" */
  environment?: LensEnvironmentName
  /** Lens Chain RPC for thirdweb. Defaults to thirdweb's RPC. */
  lensChainRpcUrl?: string
  /** Prefix of the localStorage keys the session is stored under. Defaults to "lens_". */
  storagePrefix?: string
  /** Route that exchanges a Lens ID token for a Convex token. Defaults to "/api/convex-token". */
  convexTokenEndpoint?: string
}

export type LensLoginRole = "ACCOUNT_OWNER" | "ACCOUNT_MANAGER"

export type LensChallenge = { id: UUID; text: string }

export type MessageSigner = {
  signMessage: (args: { message: string }) => Promise<string>
}

// The signed-in Lens account (lowercased address) and its session, read from the stored ID token
export type LensSessionInfo = { account: string; sessionId: string }

export type LensAuth = ReturnType<typeof createLensAuth>

// Challenges are fetched ahead of time so a tap can sign right away: how often they're replaced, and how
// old one can be to still be used.
export const CHALLENGE_REFRESH_MS = 2 * 60 * 1000
export const CHALLENGE_MAX_AGE_MS = 4 * 60 * 1000

// On phones and tablets thirdweb opens the wallet app with a deep link to sign (same check as its
// internal isMobile), and that deep link only works right after a tap.
export function opensWalletWithDeepLink() {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

// Asks the wallet to sign synchronously (no awaits before it), so call it directly from a click handler.
export function signLensChallenge(challenge: LensChallenge, signer: MessageSigner): Promise<string> {
  return signer.signMessage({ message: challenge.text })
}

// A Lens SDK session's tokens
export function sessionCredentials(session: SessionClient): LensCredentials {
  const credentials = session.getCredentials()
  if (credentials.isErr()) throw credentials.error
  if (!credentials.value) throw new Error("The Lens session has no credentials")
  return credentials.value
}

// Create once per app (at module level) and pass to <LensAuthProvider>.
export function createLensAuth(options: LensAuthOptions) {
  if (!options.thirdwebClientId) throw new Error("lens-convex-auth: thirdwebClientId is required")
  if (!ADDRESS_RE.test(options.lensAppAddress ?? "")) {
    throw new Error("lens-convex-auth: lensAppAddress must be your Lens app address (0x…)")
  }

  const environment: LensEnvironmentName = options.environment ?? "mainnet"
  const storagePrefix = options.storagePrefix ?? "lens_"
  const appAddress = options.lensAppAddress
  const convexTokenEndpoint = options.convexTokenEndpoint ?? DEFAULT_CONVEX_TOKEN_ENDPOINT

  const tokens = new TokenService({ storagePrefix, graphqlUrl: `${lensApiOrigin(environment)}/graphql` })
  const thirdwebClient: ThirdwebClient = createThirdwebClient({ clientId: options.thirdwebClientId })
  const chain: Chain = lensThirdwebChain(environment, options.lensChainRpcUrl)
  const viemChain: ViemChain = lensViemChain(environment)
  const lensEnvironment = environment === "testnet" ? testnet : mainnet
  const lensClient = PublicClient.create({
    environment: lensEnvironment,
    storage: typeof window !== "undefined" ? new LensTokenStorage(tokens, `${storagePrefix}custom_`) : undefined,
  })

  // The signed-in account, or null when signed out
  function getSession(): LensSessionInfo | null {
    const idToken = tokens.getStoredTokens()?.idToken
    return idToken ? lensSessionFromIdToken(idToken) : null
  }

  // True when there's a valid session, refreshing its tokens first if needed (a session that can't be
  // refreshed is cleared). Also resumes it in the Lens client, so Lens SDK calls and hooks act as the
  // signed-in account.
  async function resumeSession(): Promise<boolean> {
    if (!(await tokens.isAuthenticated())) return false
    if (!lensClient.currentSession?.isSessionClient()) await lensClient.resumeSession()
    return true
  }

  // Logging in is split in two (challenge, then sign + authenticate) instead of using `lensClient.login`,
  // so the signature can be requested straight from a tap. On mobile, WalletConnect opens the wallet app
  // with a deep link when asked to sign, and iOS only allows that right after a user gesture: after the
  // challenge round trip the link is blocked and the wallet never shows the request.
  async function requestChallenge(opts: { role: LensLoginRole; account: string; signer: string }): Promise<LensChallenge> {
    const app = evmAddress(appAddress)
    const account = evmAddress(opts.account)
    const signer = evmAddress(opts.signer)
    const challenge = await lensClient.challenge(
      opts.role === "ACCOUNT_MANAGER"
        ? { accountManager: { account, app, manager: signer } }
        : { accountOwner: { account, app, owner: signer } },
    )
    if (challenge.isErr()) throw challenge.error
    return challenge.value
  }

  async function authenticate(challenge: LensChallenge, signature: string): Promise<SessionClient> {
    const authenticated = await lensClient.authenticate({ id: challenge.id, signature: signatureFrom(signature) })
    if (authenticated.isErr()) throw authenticated.error
    tokens.storeCredentials(sessionCredentials(authenticated.value))
    return authenticated.value
  }

  async function logout(): Promise<void> {
    tokens.clearTokens()
    // PublicClient has no logout; logout exists on SessionClient
    const session = lensClient.currentSession
    if (session && session.isSessionClient()) await session.logout()
  }

  // fetch() with the Lens ID token as `Authorization: Bearer`, retried once with a refreshed token on 401.
  // Verify it on the server with `getLensSession` from "lens-convex-auth/server".
  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const send = async (forceRefresh: boolean) => {
      const idToken = await tokens.getFreshIdToken(forceRefresh)
      const headers = new Headers(init.headers)
      if (idToken) headers.set("Authorization", `Bearer ${idToken}`)
      return fetch(input, { ...init, headers })
    }
    const response = await send(false)
    return response.status === 401 && getSession() ? send(true) : response
  }

  // Convex can't verify Lens ID tokens itself (they have no `kid` header), so the server verifies the
  // Lens ID token and issues a Convex token for the same account (see "lens-convex-auth/server").
  async function fetchConvexToken(forceRefresh = false): Promise<string | null> {
    const idToken = await tokens.getFreshIdToken(forceRefresh)
    if (!idToken) return null
    try {
      const res = await fetch(convexTokenEndpoint, { method: "POST", headers: { Authorization: `Bearer ${idToken}` } })
      if (!res.ok) return null
      const { token } = await res.json()
      return typeof token === "string" ? token : null
    } catch {
      return null
    }
  }

  return {
    environment,
    appAddress,
    storagePrefix,
    thirdwebClient,
    chain,
    viemChain,
    lensClient,
    lensEnvironment,
    tokens,
    getSession,
    resumeSession,
    requestChallenge,
    signChallenge: signLensChallenge,
    authenticate,
    logout,
    fetch: authFetch,
    fetchConvexToken,
  }
}
