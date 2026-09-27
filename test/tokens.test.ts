import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TokenService, TOKENS_CHANGED_EVENT } from "../src/core/tokens"
import { LensTokenStorage } from "../src/core/storage"
import { lensSessionFromIdToken } from "../src/core/jwt"

function jwt(claims: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`
}

const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60
const ACCOUNT = "0xAbCd000000000000000000000000000000000001"

function tokens(expMinutes = 10, suffix = "") {
  return {
    accessToken: jwt({ exp: inMinutes(expMinutes), n: `access${suffix}` }),
    idToken: jwt({ exp: inMinutes(expMinutes), sid: "s1", act: { sub: ACCOUNT }, n: `id${suffix}` }),
    refreshToken: `refresh${suffix}`,
  }
}

let events: string[]

beforeEach(() => {
  const store = new Map<string, string>()
  events = []
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const service = () => new TokenService({ storagePrefix: "lens_", graphqlUrl: "https://api.lens.xyz/graphql" })

describe("TokenService", () => {
  it("stores and reads tokens, using the access token's own expiry", () => {
    const s = service()
    const t = tokens(7)
    s.storeCredentials(t)
    const stored = s.getStoredTokens()!
    expect(stored.idToken).toBe(t.idToken)
    expect(Math.abs(stored.expiresAt - inMinutes(7) * 1000)).toBeLessThan(1000)
    expect(localStorage.getItem("lens_access_token")).toBe(t.accessToken)
    expect(events).toEqual([TOKENS_CHANGED_EVENT])
  })

  it("returns stored tokens while fresh, without refreshing", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const s = service()
    s.storeCredentials(tokens(10))
    expect(await s.getFreshIdToken()).toBe(s.getStoredTokens()!.idToken)
    expect(await s.isAuthenticated()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes expiring tokens once for concurrent callers", async () => {
    const fresh = tokens(10, "-new")
    const fetchMock = vi.fn(async () => Response.json({ data: { refresh: fresh } }))
    vi.stubGlobal("fetch", fetchMock)
    const s = service()
    s.storeCredentials(tokens(0.5))
    const [a, b] = await Promise.all([s.getFreshIdToken(), s.getValidAccessToken()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(fresh.idToken)
    expect(b).toBe(fresh.accessToken)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.variables.request.refreshToken).toBe("refresh")
  })

  it("a forced refresh reuses tokens another tab just got", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const s = service()
    s.storeCredentials(tokens(10))
    await s.getFreshIdToken(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("clears the session when it can't be refreshed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { refresh: { reason: "expired" } } })))
    const s = service()
    s.storeCredentials(tokens(0))
    expect(await s.getFreshIdToken()).toBeNull()
    expect(s.getStoredTokens()).toBeNull()
  })
})

describe("LensTokenStorage", () => {
  it("round-trips the Lens SDK's credentials through the TokenService", () => {
    const s = service()
    const storage = new LensTokenStorage(s, "lens_custom_")
    const t = tokens(10)
    const metadata = { version: 3, createdAt: 1, updatedAt: 2 }
    storage.setItem("lens.mainnet.credentials", JSON.stringify({ data: t, metadata }))
    expect(s.getStoredTokens()?.accessToken).toBe(t.accessToken)
    expect(JSON.parse(storage.getItem("lens.mainnet.credentials")!)).toEqual({ data: t, metadata })

    storage.setItem("other", "value")
    expect(localStorage.getItem("lens_custom_other")).toBe("value")

    storage.removeItem("lens.mainnet.credentials")
    expect(s.getStoredTokens()).toBeNull()
    expect(storage.getItem("lens.mainnet.credentials")).toBeNull()
  })
})

describe("lensSessionFromIdToken", () => {
  it("reads the account and session, lowercased", () => {
    expect(lensSessionFromIdToken(tokens().idToken)).toEqual({ account: ACCOUNT.toLowerCase(), sessionId: "s1" })
    expect(lensSessionFromIdToken(jwt({ sub: "0x1" }))).toBeNull()
    expect(lensSessionFromIdToken("nope")).toBeNull()
  })
})
