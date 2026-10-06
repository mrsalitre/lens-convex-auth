import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLensAuth } from "../src/core/auth"

function jwt(claims: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`
}

const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60

function session(name: string) {
  const exp = inMinutes(10)
  return {
    accessToken: jwt({ exp, n: `access-${name}` }),
    idToken: jwt({ exp, sid: `sid-${name}`, act: { sub: `0x${name.padStart(40, "0")}` } }),
    refreshToken: `refresh-${name}`,
  }
}

const createAuth = () =>
  createLensAuth({ thirdwebClientId: "test", lensAppAddress: `0x${"1".repeat(40)}` })

// Stands in for the Lens client's authenticate, which (like the real one) stores the new session's
// tokens itself, through LensTokenStorage, before returning
function authenticatesAs(auth: ReturnType<typeof createAuth>, credentials: ReturnType<typeof session>) {
  const sessionClient = { getCredentials: () => ({ isErr: () => false, value: credentials }) }
  vi.spyOn(auth.lensClient, "authenticate").mockImplementation((async () => {
    auth.tokens.storeCredentials(credentials)
    return { isErr: () => false, value: sessionClient }
  }) as never)
}

let revoked: string[]
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal("window", { dispatchEvent: () => true })
  revoked = []
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    revoked.push(body.variables.request.authenticationId)
    return Response.json({ data: { revokeAuthentication: null } })
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const challenge = { id: "00000000-0000-0000-0000-000000000000", text: "sign me" } as never

describe("switching accounts", () => {
  it("revokes the session it replaces", async () => {
    const auth = createAuth()
    auth.tokens.storeCredentials(session("a"))
    authenticatesAs(auth, session("b"))
    await auth.authenticate(challenge, "0xabcd")
    expect(revoked).toEqual(["sid-a"])
    expect(auth.getSession()?.sessionId).toBe("sid-b")
  })

  it("revokes nothing on a first sign-in", async () => {
    const auth = createAuth()
    authenticatesAs(auth, session("a"))
    await auth.authenticate(challenge, "0xabcd")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keeps the new session when the old one can't be revoked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    fetchMock.mockImplementation(async () => { throw new TypeError("offline") })
    const auth = createAuth()
    auth.tokens.storeCredentials(session("a"))
    expect(await auth.startSession(session("b"))).toBe(false)
    expect(auth.getSession()?.sessionId).toBe("sid-b")
  })
})

describe("logout", () => {
  it("clears the session, revokes it, and drops the Lens client's session", async () => {
    const auth = createAuth()
    auth.tokens.storeCredentials(session("a"))
    expect(await auth.logout()).toEqual({ revoked: true })
    expect(revoked).toEqual(["sid-a"])
    expect(auth.getSession()).toBeNull()
    expect(auth.lensClient.currentSession).toBe(auth.lensClient)
  })

  it("reports a session it couldn't revoke, after clearing it", async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError("offline") })
    const auth = createAuth()
    auth.tokens.storeCredentials(session("a"))
    expect(await auth.logout()).toEqual({ revoked: false })
    expect(auth.getSession()).toBeNull()
  })

  it("has nothing to revoke when signed out", async () => {
    expect(await createAuth().logout()).toEqual({ revoked: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
