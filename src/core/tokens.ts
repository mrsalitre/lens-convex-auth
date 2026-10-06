import { LENS_TOKEN_LIFETIME_MS } from "./constants"
import { decodeJwtPayload, jwtExpiresAt } from "./jwt"

export interface TokenData {
  accessToken: string
  idToken: string
  refreshToken: string
  expiresAt: number // when the access token expires (ms since epoch)
}

export type LensCredentials = Pick<TokenData, "accessToken" | "idToken" | "refreshToken">

// Dispatched on window whenever tokens are stored or cleared in this tab
export const TOKENS_CHANGED_EVENT = "lens-convex-auth:tokens-changed"

// Refresh a minute before expiry for smoother UX
const REFRESH_BUFFER_MS = 60 * 1000

const REFRESH_MUTATION = `
  mutation Refresh($request: RefreshRequest!) {
    refresh(request: $request) {
      ... on AuthenticationTokens {
        accessToken
        idToken
        refreshToken
      }
      ... on ForbiddenError {
        reason
      }
    }
  }
`

const REVOKE_MUTATION = `
  mutation RevokeAuthentication($request: RevokeAuthenticationRequest!) {
    revokeAuthentication(request: $request)
  }
`

function notifyTokensChanged() {
  try {
    window.dispatchEvent(new Event(TOKENS_CHANGED_EVENT))
  } catch {}
}

// Keeps the Lens session's tokens in localStorage, the single place every part of the app (the Lens
// SDK, Convex, API calls) reads them from, and refreshes them.
export class TokenService {
  readonly storageKeys: { accessToken: string; idToken: string; refreshToken: string; expiresAt: string }
  private refreshPromise: Promise<TokenData | null> | null = null

  constructor(private options: { storagePrefix: string; graphqlUrl: string }) {
    const p = options.storagePrefix
    this.storageKeys = {
      accessToken: `${p}access_token`,
      idToken: `${p}id_token`,
      refreshToken: `${p}refresh_token`,
      expiresAt: `${p}token_expires_at`,
    }
  }

  storeTokens(tokens: TokenData): void {
    if (typeof window === "undefined") return
    try {
      localStorage.setItem(this.storageKeys.accessToken, tokens.accessToken)
      localStorage.setItem(this.storageKeys.idToken, tokens.idToken)
      localStorage.setItem(this.storageKeys.refreshToken, tokens.refreshToken)
      localStorage.setItem(this.storageKeys.expiresAt, tokens.expiresAt.toString())
    } catch {}
    notifyTokensChanged()
  }

  storeCredentials(credentials: LensCredentials): void {
    this.storeTokens({ ...credentials, expiresAt: Date.now() + LENS_TOKEN_LIFETIME_MS })
  }

  getStoredTokens(): TokenData | null {
    if (typeof window === "undefined") return null
    try {
      const accessToken = localStorage.getItem(this.storageKeys.accessToken)
      const idToken = localStorage.getItem(this.storageKeys.idToken)
      const refreshToken = localStorage.getItem(this.storageKeys.refreshToken)
      const storedExpiresAt = localStorage.getItem(this.storageKeys.expiresAt)
      if (!accessToken || !idToken || !refreshToken) return null
      // The access token's own expiry. The stored value is only an estimate (store time + 10 min),
      // which marks tokens read back from an old session as fresh long after they expired.
      const expiresAt = jwtExpiresAt(accessToken) ?? (storedExpiresAt ? parseInt(storedExpiresAt, 10) : 0)
      return { accessToken, idToken, refreshToken, expiresAt }
    } catch {
      return null
    }
  }

  clearTokens(): void {
    if (typeof window === "undefined") return
    try {
      for (const key of Object.values(this.storageKeys)) localStorage.removeItem(key)
    } catch {}
    notifyTokensChanged()
  }

  // Current access token, refreshed first if it's about to expire
  async getValidAccessToken(): Promise<string | null> {
    const tokens = this.getStoredTokens()
    if (!tokens) return null
    if (tokens.expiresAt > Date.now() + REFRESH_BUFFER_MS) return tokens.accessToken
    return (await this.refreshTokens())?.accessToken ?? null
  }

  // ID token for authenticating to your backend (Convex, API routes), refreshed when it's about to
  // expire (by the token's own `exp` claim). `forceRefresh` is for when the backend rejected it.
  async getFreshIdToken(forceRefresh = false): Promise<string | null> {
    const tokens = this.getStoredTokens()
    if (!tokens) return null
    const expiresAt = jwtExpiresAt(tokens.idToken) ?? 0
    const fresh = expiresAt > Date.now() + REFRESH_BUFFER_MS
    // A forced refresh right after another tab or the background refresher got new tokens reuses them
    const justIssued = expiresAt > Date.now() + 2 * REFRESH_BUFFER_MS
    if (fresh && (!forceRefresh || justIssued)) return tokens.idToken
    return (await this.refreshTokens())?.idToken ?? null
  }

  async isAuthenticated(): Promise<boolean> {
    return !!(await this.getValidAccessToken())
  }

  // Concurrent calls share one request. Clears the tokens when the session can't be refreshed.
  refreshTokens(): Promise<TokenData | null> {
    this.refreshPromise ??= this.performRefresh().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  // Ends a session on the Lens API, so its tokens stop working even if they were copied out of this
  // browser. Takes the session's tokens rather than the stored ones, because by the time a session is
  // revoked the storage already holds the next one (or nothing). Its refresh token stops working right
  // away; an access or ID token already issued stays valid until it expires (10 minutes at most).
  // Resolves false when the API couldn't be reached or refused.
  async revokeSession(tokens: LensCredentials): Promise<boolean> {
    const authenticationId = decodeJwtPayload(tokens.idToken)?.sid
    if (typeof authenticationId !== "string") return false
    try {
      // Revoking needs a valid access token for the session itself
      let accessToken = tokens.accessToken
      if ((jwtExpiresAt(accessToken) ?? 0) <= Date.now() + REFRESH_BUFFER_MS) {
        const refreshed = await this.requestRefresh(tokens.refreshToken)
        // A session that can't be refreshed has already ended (expired, or revoked elsewhere)
        if (!refreshed) return true
        accessToken = refreshed.accessToken
      }
      const data = await this.graphql(REVOKE_MUTATION, { request: { authenticationId } }, accessToken)
      return !data.errors
    } catch {
      return false
    }
  }

  private async performRefresh(): Promise<TokenData | null> {
    const refreshToken = this.getStoredTokens()?.refreshToken
    if (!refreshToken) {
      this.clearTokens()
      return null
    }
    try {
      // Resuming the Lens session only reads these same tokens back, so ask the API for new ones.
      // (Each Lens SDK session keeps its own copy of the tokens and refreshes that copy itself.)
      const refreshed = await this.requestRefresh(refreshToken)
      // Signed out, or signed in again, while the request was in flight: those tokens are for a session
      // that's no longer this browser's
      if (this.getStoredTokens()?.refreshToken !== refreshToken) return this.getStoredTokens()
      if (!refreshed) throw new Error("Refresh refused")
      const tokens: TokenData = { ...refreshed, expiresAt: Date.now() + LENS_TOKEN_LIFETIME_MS }
      this.storeTokens(tokens)
      return tokens
    } catch {
      if (this.getStoredTokens()?.refreshToken === refreshToken) this.clearTokens()
      return null
    }
  }

  // New tokens for a session, from its refresh token. Doesn't store them. Null when the API refuses (the
  // session has ended); throws when it can't be reached.
  private async requestRefresh(refreshToken: string): Promise<LensCredentials | null> {
    const data = await this.graphql(REFRESH_MUTATION, { request: { refreshToken } })
    const result = data?.data?.refresh
    if (data?.errors || !result?.accessToken || !result.idToken || !result.refreshToken) return null
    return { accessToken: result.accessToken, idToken: result.idToken, refreshToken: result.refreshToken }
  }

  private async graphql(query: string, variables: Record<string, unknown>, accessToken?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    const response = await fetch(this.options.graphqlUrl, { method: "POST", headers, body: JSON.stringify({ query, variables }) })
    return response.json()
  }
}
