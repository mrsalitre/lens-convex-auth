import type { IStorageProvider } from "@lens-protocol/client"
import type { TokenService } from "./tokens"

// Storage for the Lens SDK that keeps its credentials in the TokenService, so the SDK and the app
// share one copy of the session. Everything else the SDK stores goes to localStorage under a prefix.
export class LensTokenStorage implements IStorageProvider {
  constructor(private tokens: TokenService, private prefix: string) {}

  private isCredentials(key: string) {
    return key.includes("credentials") || key.includes("session")
  }

  // The SDK only accepts a stored credentials item whose metadata is exactly
  // { version, createdAt, updatedAt }, so keep the metadata it wrote and hand it back unchanged.
  private metadataKey(key: string) {
    return `${this.prefix}${key}:metadata`
  }

  private credentialsMetadata(key: string) {
    const stored = localStorage.getItem(this.metadataKey(key))
    if (stored) return JSON.parse(stored)
    // Tokens stored before the metadata was kept: 3 is the SDK's current credentials schema version.
    const now = Date.now()
    return { version: 3, createdAt: now, updatedAt: now }
  }

  getItem(key: string): string | null {
    if (typeof window === "undefined") return null
    try {
      if (!this.isCredentials(key)) return localStorage.getItem(this.prefix + key)
      // An external session has no refresh token: its owner renews it before the SDK would try
      const external = this.tokens.getExternalSession()
      if (external) return JSON.stringify({ data: { ...external, refreshToken: "" }, metadata: this.credentialsMetadata(key) })
      const tokens = this.tokens.getStoredTokens()
      if (!tokens) return null
      return JSON.stringify({
        data: { accessToken: tokens.accessToken, idToken: tokens.idToken, refreshToken: tokens.refreshToken },
        metadata: this.credentialsMetadata(key),
      })
    } catch {
      return null
    }
  }

  setItem(key: string, value: string): void {
    if (typeof window === "undefined") return
    try {
      if (!this.isCredentials(key)) return localStorage.setItem(this.prefix + key, value)
      // Never write an external session's tokens to storage
      if (this.tokens.getExternalSession()) return
      const parsed = JSON.parse(value)
      const data = typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data
      if (data?.accessToken && data?.idToken && data?.refreshToken) {
        this.tokens.storeCredentials(data)
        localStorage.setItem(this.metadataKey(key), JSON.stringify(parsed.metadata))
      }
    } catch {}
  }

  removeItem(key: string): void {
    if (typeof window === "undefined") return
    try {
      if (!this.isCredentials(key)) return localStorage.removeItem(this.prefix + key)
      // The SDK logging out of an external session: its owner ends it, and the stored session stays
      if (this.tokens.getExternalSession()) return
      this.tokens.clearTokens()
      localStorage.removeItem(this.metadataKey(key))
    } catch {}
  }
}
