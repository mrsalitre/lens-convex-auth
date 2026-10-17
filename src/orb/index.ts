import {
  SigningError,
  ValidationError,
  errAsync,
  isTransactionRequest,
  okAsync,
  ResultAsync,
  txHash,
  type OperationHandler,
  type SelfFundedTransactionRequest,
  type SponsoredTransactionRequest,
  type TxHash,
} from "@lens-protocol/client"
import {
  OrbAppsClient,
  OrbConnectDeclinedError,
  OrbConnectTimeoutError,
  OrbNotAvailableError,
  isInsideOrb,
  type OrbAppContext,
  type OrbAuthTokens,
} from "@orbclub/apps-sdk/client"
import type { LensAuth } from "../core/auth"
import { DEFAULT_ORB_CONVEX_TOKEN_ENDPOINT } from "../core/constants"
import { jwtExpiresAt } from "../core/jwt"
import type { OrbAuthSource, OrbSessionState } from "./types"

export type { OrbAuthSource, OrbSessionState, OrbSessionStatus } from "./types"

export type OrbAuthOptions = {
  /** Route that exchanges the Orb access token for a Convex token. Defaults to "/api/convex-token/orb". */
  convexTokenEndpoint?: string
  /**
   * Asks the viewer to stay signed in, so Orb renews the session in the background and signs them back in
   * after a reload. With false, the session ends with its access token (about ten minutes), and a reload
   * signs the viewer out, even if they let your app stay signed in before. Defaults to true.
   */
  stayLoggedIn?: boolean
  /**
   * From createLensAuth(). The Orb session then becomes its Lens client's session while the viewer is signed in,
   * so Lens SDK calls and hooks act as their Orb profile, and `handleOperation` sends what needs signing to Orb.
   * Without it the Lens client stays public inside Orb.
   */
  lens?: LensAuth
  /** Sets `data-orb-theme` and `color-scheme` on <html> from Orb's theme. Defaults to true. */
  applyTheme?: boolean
  /** Writes Orb's safe-area insets to `--orb-safe-top` (and bottom, left, right) on <html>. Defaults to true. */
  applySafeAreaInsets?: boolean
}

export type OrbAuth = ReturnType<typeof createOrbAuth>

// Inside Orb, ask it to renew the session this long before the access token expires
const RENEW_BEFORE_EXPIRY_MS = 60_000
// How long to wait for Orb's context before showing the viewer as signed out
const CONTEXT_WAIT_MS = 3_000
const SILENT_CONNECT_TIMEOUT_MS = 30_000

type Tokens = { idToken: string; accessToken: string }

// The Lens account a token acts for, lowercased. Decoded without verifying: enough to notice a profile
// switch, never to authorize (the server verifies).
function accountOf(token: string): string | null {
  return OrbAppsClient.getAccountAddressFromToken(token)?.toLowerCase() ?? null
}

// Keeps the ID and access tokens only: a refresh token is never kept, even from older Orb versions that
// still return one
function toTokens(tokens: OrbAuthTokens): Tokens {
  if (!tokens.accessToken) throw new Error("Orb didn't return an access token.")
  return { idToken: tokens.idToken, accessToken: tokens.accessToken }
}

function describeError(err: unknown): string {
  if (err instanceof OrbConnectDeclinedError) return "Sign-in was declined in Orb."
  if (err instanceof OrbConnectTimeoutError) return "Sign-in timed out. Try again."
  if (err instanceof OrbNotAvailableError) return "Sign in with Orb only works inside the Orb app."
  return err instanceof Error ? err.message : "Sign-in failed. Try again."
}

// Signs the viewer in with their Orb profile when the app runs inside Orb. Create once per app (at module
// level) and pass to <LensAuthProvider orb={…}>. Outside Orb it does nothing, so the same app keeps
// signing in with a wallet on the web.
//
// The tokens stay in memory, as Orb asks: Orb keeps the refresh token and renews the session itself. All
// Orb profiles on a phone share the page's storage, so a session only lasts while Orb shows its profile.
export function createOrbAuth(options: OrbAuthOptions = {}) {
  const convexTokenEndpoint = options.convexTokenEndpoint ?? DEFAULT_ORB_CONVEX_TOKEN_ENDPOINT
  const stayLoggedIn = options.stayLoggedIn !== false
  const credentials = stayLoggedIn ? "id_access_refresh" : "id_access"

  const listeners = new Set<() => void>()
  let client: OrbAppsClient | null = null
  let state: OrbSessionState = { status: "loading", account: null, sessionId: 0, error: null }
  let tokens: Tokens | null = null
  // Whether the session was checked against the profile Orb showed; it ends once Orb shows another
  let boundToProfile = false
  // Bumped to abandon a sign-in in flight (another sign-in, signing out)
  let attempt = 0
  // The profile a silent sign-in was last tried for, so it's tried once per profile (not on every context
  // update, and not right after the viewer signed out)
  let restoredFor: string | null | undefined
  // How many start() calls haven't been stopped. React can stop and start again right away (Strict Mode,
  // Fast Refresh), so a silent sign-in still in flight is kept unless none are left when it finishes.
  let activeStarts = 0
  let renewing: Promise<void> | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let renewTimer: ReturnType<typeof setTimeout> | undefined

  function insideOrb() {
    return typeof window !== "undefined" && isInsideOrb()
  }

  // The page's one OrbAppsClient, created when the provider starts (after hydration: it writes Orb's theme and
  // safe-area insets on <html>, which would no longer match the server's HTML)
  function ensureClient(): OrbAppsClient | null {
    if (!client && insideOrb()) {
      client = new OrbAppsClient({ applyTheme: options.applyTheme, applySafeAreaInsets: options.applySafeAreaInsets })
      // Once, on startup: until then, cross-origin iframes on the page can use Orb's bridge too
      client.ready()
    }
    return client
  }

  function update(patch: Partial<OrbSessionState>) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function selectedProfile(): string | null {
    return client?.context?.user.profileId?.toLowerCase() || null
  }

  function isSelectedAccount(token: string) {
    const profile = selectedProfile()
    return !!profile && accountOf(token) === profile
  }

  function usernameFor(address: string): string | null {
    const user = client?.context?.user
    if (user?.profileId?.toLowerCase() !== address || !user.handle) return null
    return user.handle.replace(/^@/, "")
  }

  // Whether Orb may renew the session and sign the viewer back in without showing anything: the app asks to
  // stay signed in, and this Orb version supports it (older ones ignore `prompt: "none"` and would show the
  // approval sheet)
  function canConnectSilently() {
    return stayLoggedIn && client?.context?.features.grantRenewal === true
  }

  function clearTimers() {
    clearTimeout(expiryTimer)
    clearTimeout(renewTimer)
    expiryTimer = renewTimer = undefined
  }

  // Gives the Lens client the current Orb session, or takes it back (see the `lens` option)
  function syncLens() {
    options.lens
      ?.setExternalSession(tokens && { accessToken: tokens.accessToken, idToken: tokens.idToken })
      .catch((err) => console.warn("lens-convex-auth: couldn't give the Lens client the Orb session", err))
  }

  function endSession(error: string | null) {
    clearTimers()
    tokens = null
    syncLens()
    boundToProfile = false
    update({ status: "signed-out", account: null, error })
  }

  function startSession(next: Tokens) {
    const address = accountOf(next.accessToken)
    // A token without a readable expiry can't be ended on time: fail closed
    const expiresAt = jwtExpiresAt(next.accessToken)
    if (!address || !expiresAt || expiresAt <= Date.now()) {
      endSession("Orb returned a session that can't be used. Sign in again.")
      return
    }
    const renewal = !!tokens && accountOf(tokens.accessToken) === address
    clearTimers()
    tokens = next
    syncLens()
    boundToProfile = !!selectedProfile()
    update({
      status: "signed-in",
      account: { address, username: usernameFor(address) },
      sessionId: renewal ? state.sessionId : state.sessionId + 1,
      error: null,
    })

    // The page never holds a refresh token: the session lasts as long as the access token, unless Orb
    // renews it first
    expiryTimer = setTimeout(() => endSession("Your Orb session expired. Sign in again."), expiresAt - Date.now())
    if (canConnectSilently()) {
      renewTimer = setTimeout(() => void renew(), Math.max(0, expiresAt - Date.now() - RENEW_BEFORE_EXPIRY_MS))
    }
  }

  // Signs the selected profile back in without showing anything, when it already approved this app and
  // asked to stay signed in. Null when Orb can't (it declined, or doesn't support it).
  async function connectSilently(): Promise<Tokens | null> {
    if (!client || !canConnectSilently()) return null
    try {
      const result = await client.connect({ credentials: "id_access_refresh", prompt: "none", timeout: SILENT_CONNECT_TIMEOUT_MS })
      // Orb answers for the profile selected when it handled the request: keep it only if that's still the one
      return result.accessToken && isSelectedAccount(result.accessToken) ? toTokens(result) : null
    } catch {
      return null
    }
  }

  async function restore() {
    // A context update (one bringing the device wallet, say) mustn't interrupt the approval sheet
    if (!client || tokens || state.status === "signing-in") return
    const profile = selectedProfile()
    if (restoredFor === profile) return
    restoredFor = profile
    if (!canConnectSilently()) {
      if (state.status === "loading") update({ status: "signed-out" })
      return
    }
    const current = ++attempt
    update({ status: "loading" })
    const restored = await connectSilently()
    if (current !== attempt) return
    // Stopped meanwhile: don't start a session nothing follows. The next start() tries again.
    if (activeStarts === 0) {
      restoredFor = undefined
      return
    }
    if (restored) startSession(restored)
    else update({ status: "signed-out" })
  }

  // Concurrent calls (the renewal timer, Convex asking for a token) share one request to Orb
  function renew(): Promise<void> {
    renewing ??= (async () => {
      const current = tokens
      if (!current) return
      const renewed = await connectSilently()
      if (!renewed || tokens !== current) return
      const renewedExpiry = jwtExpiresAt(renewed.accessToken)
      const currentExpiry = jwtExpiresAt(current.accessToken)
      // Orb may answer with the same token. One that isn't extended enough mustn't start another renewal
      // right away: the session then ends when the current token expires.
      if (
        renewedExpiry && currentExpiry && renewedExpiry > currentExpiry &&
        renewedExpiry > Date.now() + RENEW_BEFORE_EXPIRY_MS &&
        accountOf(renewed.accessToken) === accountOf(current.accessToken)
      ) {
        startSession(renewed)
      }
    })().finally(() => {
      renewing = null
    })
    return renewing
  }

  function handleContext(context: OrbAppContext) {
    // Never stay signed in as a profile Orb no longer shows
    if (tokens && (context.user.profileId || boundToProfile) && !isSelectedAccount(tokens.accessToken)) {
      endSession(null)
    }
    if (tokens) {
      const username = state.account ? usernameFor(state.account.address) : null
      if (state.account && username && username !== state.account.username) update({ account: { ...state.account, username } })
      return
    }
    void restore()
  }

  function start(): () => void {
    const orbClient = ensureClient()
    if (!orbClient) {
      if (state.status === "loading") update({ status: "signed-out" })
      return () => {}
    }
    activeStarts++
    const unsubscribe = orbClient.onContextChange(handleContext)
    let wait: ReturnType<typeof setTimeout> | undefined
    // Orb can send its context after the page loads
    if (orbClient.context) handleContext(orbClient.context)
    else {
      wait = setTimeout(() => {
        if (state.status === "loading" && !orbClient.context) update({ status: "signed-out" })
      }, CONTEXT_WAIT_MS)
    }
    return () => {
      activeStarts--
      clearTimeout(wait)
      unsubscribe()
    }
  }

  async function signIn(): Promise<void> {
    const orbClient = ensureClient()
    if (tokens) return
    if (!orbClient) {
      update({ status: "signed-out", error: describeError(new OrbNotAvailableError()) })
      return
    }
    const current = ++attempt
    update({ status: "signing-in", error: null })
    try {
      const profileBefore = selectedProfile()
      const result = await orbClient.connect({ credentials })
      if (current !== attempt) return
      if ((profileBefore || selectedProfile()) && !(result.accessToken && isSelectedAccount(result.accessToken))) {
        throw new Error("Your Orb profile changed during sign-in. Try again.")
      }
      restoredFor = selectedProfile()
      startSession(toTokens(result))
    } catch (err) {
      if (current === attempt) update({ status: "signed-out", error: describeError(err) })
    }
  }

  // Ends the session in this page and tells Orb the viewer signed out. The access token Orb issued stays
  // valid until it expires (about ten minutes); there's no refresh token in the page to revoke.
  async function signOut(): Promise<void> {
    attempt++
    // Don't sign the same profile back in silently
    restoredFor = selectedProfile()
    endSession(null)
    try {
      await client?.disconnect()
    } catch {}
  }

  // Convex can't verify Orb's tokens itself, so the server verifies the access token with Orb and issues
  // a Convex token for the same account (see "lens-convex-auth/orb/server").
  async function fetchConvexToken(_forceRefresh = false): Promise<string | null> {
    // Convex asks again shortly before its token expires, which is when the Orb session does too
    if (tokens && (jwtExpiresAt(tokens.accessToken) ?? 0) < Date.now() + RENEW_BEFORE_EXPIRY_MS) await renew()
    const accessToken = tokens?.accessToken
    if (!accessToken) return null
    try {
      const res = await fetch(convexTokenEndpoint, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } })
      if (!res.ok) return null
      const { token } = await res.json()
      return typeof token === "string" ? token : null
    } catch {
      return null
    }
  }

  // fetch() with the Orb access token as `Authorization: Bearer`. Send it only to your own server, and
  // verify it there with `getOrbSession` from "lens-convex-auth/orb/server".
  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (tokens) headers.set("Authorization", `Bearer ${tokens.accessToken}`)
    return fetch(input, { ...init, headers })
  }

  // Sends a transaction the Lens API prepared through Orb's approval sheet, signed by Orb's wallet for the
  // profile (the account manager Orb's sessions act through)
  async function sendThroughOrb(raw: (SponsoredTransactionRequest | SelfFundedTransactionRequest)["raw"]): Promise<TxHash> {
    if (!client) throw new OrbNotAvailableError()
    // Orb doesn't document the unit of its `amount` yet, and a wrong one would misprice a payment. Lens account
    // actions pay from the account itself, with no native value on the transaction.
    if (BigInt(raw.value) !== 0n) throw new Error("Orb can't send transactions with a native amount yet.")
    const device = client.context?.user.deviceWalletAddress
    if (device && device.toLowerCase() !== raw.from.toLowerCase()) {
      throw new Error("This transaction has to be signed by another wallet than Orb's.")
    }
    const custom = "customData" in raw ? raw.customData : null
    const { transactionHash } = await client.performTransaction({
      to: raw.to,
      chainId: raw.chainId,
      data: raw.data,
      amount: "0",
      maxGas: raw.gasLimit,
      maxFeePerGas: raw.maxFeePerGas,
      maxPriorityFeePerGas: raw.maxPriorityFeePerGas,
      nonce: raw.nonce,
      gasPerPubdata: custom?.gasPerPubdata,
      paymaster: custom?.paymasterParams?.paymaster,
      paymasterInput: custom?.paymasterParams?.paymasterInput,
      customSignature: custom?.customSignature ?? undefined,
    })
    if (!transactionHash) throw new Error("Orb didn't return the transaction's hash.")
    return txHash(transactionHash)
  }

  // Inside Orb, what `handleOperationWith(walletClient)` from @lens-protocol/client/viem does with a wallet:
  // `.andThen(orb.handleOperation)`. What Lens already did (signless) passes its hash on; a transaction to sign
  // opens Orb's approval sheet. Its result only says Orb sent it: wait for it as usual (`waitForTransaction`).
  const handleOperation = ((result) => {
    if ("hash" in result) return okAsync(result.hash)
    if (!isTransactionRequest(result)) return errAsync(ValidationError.fromErrorResponse(result))
    return ResultAsync.fromPromise(sendThroughOrb(result.raw), (err) => SigningError.from(err))
  }) as OperationHandler

  const orbAuth = {
    isInsideOrb: insideOrb,
    /**
     * The page's OrbAppsClient, for Orb's other bridge actions (performTransaction, tip, …). Null outside Orb,
     * and until <LensAuthProvider> starts (after hydration).
     */
    get client(): OrbAppsClient | null {
      return client
    },
    /** What Orb tells the page about the viewer and the device. Null outside Orb, or until Orb sends it. */
    get context(): OrbAppContext | null {
      return client?.context ?? null
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => state,
    start,
    signIn,
    signOut,
    fetchConvexToken,
    fetch: authFetch,
    handleOperation,
  }
  return orbAuth satisfies OrbAuthSource
}
