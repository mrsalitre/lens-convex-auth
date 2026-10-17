// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// Stands in for the Orb app around the page: the SDK's client talks to it through the bridge
const host = vi.hoisted(() => ({
  inside: true,
  context: null as unknown,
  clients: [] as Array<{
    context: unknown
    ready: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    emit: (context: unknown) => void
  }>,
  connect: (async () => ({})) as (options: unknown) => Promise<unknown>,
}))

vi.mock("@orbclub/apps-sdk/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orbclub/apps-sdk/client")>()
  class FakeOrbAppsClient {
    static getAccountAddressFromToken = actual.OrbAppsClient.getAccountAddressFromToken
    context = host.context
    listeners = new Set<(context: unknown) => void>()
    ready = vi.fn()
    disconnect = vi.fn(async () => {})
    constructor() {
      host.clients.push(this)
    }
    connect(options: unknown) {
      return host.connect(options)
    }
    onContextChange(callback: (context: unknown) => void) {
      this.listeners.add(callback)
      return () => this.listeners.delete(callback)
    }
    emit(context: unknown) {
      this.context = context
      for (const listener of this.listeners) listener(context)
    }
  }
  return { ...actual, OrbAppsClient: FakeOrbAppsClient, isInsideOrb: () => host.inside }
})

import { OrbConnectDeclinedError } from "@orbclub/apps-sdk/client"
import { createOrbAuth } from "../src/orb"

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${encode({ alg: "ES256" })}.${encode(claims)}.${encode("signature")}`
}

// Tokens as Orb returns them: Lens tokens acting for the account, expiring in `seconds`
function tokensFor(account: string, seconds = 600) {
  const claims = { act: { sub: account }, exp: Math.floor(Date.now() / 1000) + seconds }
  return { idToken: jwt(claims), accessToken: jwt({ ...claims, n: Math.random() }), refreshToken: null }
}

function contextFor(profileId: string | null, { grantRenewal = true, handle = "@alice" } = {}) {
  return { user: { profileId, handle, displayName: null, avatarUrl: null, deviceWalletAddress: null }, features: { grantRenewal } }
}

const client = () => host.clients[host.clients.length - 1]

beforeEach(() => {
  host.inside = true
  host.context = contextFor(ALICE)
  host.clients = []
  host.connect = vi.fn(async () => tokensFor(ALICE))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("createOrbAuth", () => {
  it("does nothing outside Orb", async () => {
    host.inside = false
    const orb = createOrbAuth()
    expect(orb.client).toBeNull()
    orb.start()
    expect(orb.getState().status).toBe("signed-out")
    await orb.signIn()
    expect(orb.getState()).toMatchObject({ status: "signed-out", error: expect.stringMatching(/only works inside/) })
  })

  it("leaves the page alone until started (so hydration matches the server), then tells Orb it's ready", () => {
    const orb = createOrbAuth()
    expect(host.clients).toHaveLength(0)
    expect(orb.client).toBeNull()
    orb.start()
    expect(client().ready).toHaveBeenCalledOnce()
    expect(orb.client).toBe(client())
  })

  it("signs the selected profile back in without UI, when Orb can renew grants", async () => {
    const orb = createOrbAuth()
    orb.start()
    expect(orb.getState().status).toBe("loading")
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
    expect(host.connect).toHaveBeenCalledWith(expect.objectContaining({ credentials: "id_access_refresh", prompt: "none" }))
    expect(orb.getState()).toMatchObject({ account: { address: ALICE, username: "alice" }, sessionId: 1, error: null })
  })

  it("never asks for a silent sign-in when Orb can't renew grants (older versions would show the sheet)", () => {
    host.context = contextFor(ALICE, { grantRenewal: false })
    const orb = createOrbAuth()
    orb.start()
    expect(host.connect).not.toHaveBeenCalled()
    expect(orb.getState().status).toBe("signed-out")
  })

  it("drops a silent answer for another profile than the one Orb shows", async () => {
    host.connect = vi.fn(async () => tokensFor(BOB))
    const orb = createOrbAuth()
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-out"))
    expect(orb.getState().account).toBeNull()
  })

  it("waits for Orb's context, and shows the viewer signed out if it never comes", async () => {
    vi.useFakeTimers()
    host.context = null
    const orb = createOrbAuth()
    orb.start()
    expect(orb.getState().status).toBe("loading")
    await vi.advanceTimersByTimeAsync(3000)
    expect(orb.getState().status).toBe("signed-out")
  })

  it("signs in through Orb's approval sheet, asking to stay signed in", async () => {
    host.context = contextFor(ALICE, { grantRenewal: false })
    const orb = createOrbAuth()
    orb.start()
    const signingIn = orb.signIn()
    expect(orb.getState().status).toBe("signing-in")
    await signingIn
    expect(host.connect).toHaveBeenCalledWith({ credentials: "id_access_refresh" })
    expect(orb.getState()).toMatchObject({ status: "signed-in", account: { address: ALICE } })
  })

  it("with stayLoggedIn: false, asks for a temporary session and never renews or restores it silently", async () => {
    vi.useFakeTimers()
    // Orb could renew, and the profile may have approved staying signed in before
    host.connect = vi.fn(async () => tokensFor(ALICE, 120))
    const orb = createOrbAuth({ stayLoggedIn: false })
    orb.start()
    expect(orb.getState().status).toBe("signed-out")
    expect(host.connect).not.toHaveBeenCalled()

    await orb.signIn()
    expect(host.connect).toHaveBeenCalledExactlyOnceWith({ credentials: "id_access" })
    await vi.advanceTimersByTimeAsync(121_000)
    expect(host.connect).toHaveBeenCalledOnce()
    expect(orb.getState()).toMatchObject({ status: "signed-out", error: expect.stringMatching(/expired/) })
  })

  it("says why a sign-in failed", async () => {
    host.context = contextFor(ALICE, { grantRenewal: false })
    host.connect = vi.fn(async () => {
      throw new OrbConnectDeclinedError()
    })
    const orb = createOrbAuth()
    orb.start()
    await orb.signIn()
    expect(orb.getState()).toMatchObject({ status: "signed-out", error: "Sign-in was declined in Orb." })
  })

  it("refuses a sign-in that came back for another profile", async () => {
    host.context = contextFor(ALICE, { grantRenewal: false })
    host.connect = vi.fn(async () => tokensFor(BOB))
    const orb = createOrbAuth()
    orb.start()
    await orb.signIn()
    expect(orb.getState()).toMatchObject({ status: "signed-out", error: expect.stringMatching(/profile changed/) })
  })

  it("ends the session when Orb switches to another profile, then signs that one in", async () => {
    const orb = createOrbAuth()
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
    host.connect = vi.fn(async () => tokensFor(BOB))
    client().emit(contextFor(BOB, { handle: "bob" }))
    expect(orb.getState().account).toBeNull()
    await vi.waitFor(() => expect(orb.getState().account).toEqual({ address: BOB, username: "bob" }))
    expect(orb.getState().sessionId).toBe(2)
  })

  it("renews the session a minute before it expires, keeping the same session", async () => {
    vi.useFakeTimers()
    host.connect = vi.fn(async () => tokensFor(ALICE, 120))
    const orb = createOrbAuth()
    orb.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(orb.getState().status).toBe("signed-in")
    host.connect = vi.fn(async () => tokensFor(ALICE, 600))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.connect).toHaveBeenCalledWith(expect.objectContaining({ prompt: "none" }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(orb.getState()).toMatchObject({ status: "signed-in", sessionId: 1 })
  })

  it("ends the session when its token expires and Orb doesn't renew it", async () => {
    vi.useFakeTimers()
    host.connect = vi.fn(async () => tokensFor(ALICE, 120))
    const orb = createOrbAuth()
    orb.start()
    await vi.advanceTimersByTimeAsync(0)
    host.connect = vi.fn(async () => {
      throw new OrbConnectDeclinedError()
    })
    await vi.advanceTimersByTimeAsync(121_000)
    expect(orb.getState()).toMatchObject({ status: "signed-out", account: null, error: expect.stringMatching(/expired/) })
  })

  it("exchanges the access token for a Convex token, and sends it with orb.fetch", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "convex-token" }))
    vi.stubGlobal("fetch", fetch)
    const orb = createOrbAuth()
    expect(await orb.fetchConvexToken()).toBeNull()
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
    const { accessToken } = await (host.connect as ReturnType<typeof vi.fn>).mock.results[0].value

    expect(await orb.fetchConvexToken()).toBe("convex-token")
    expect(fetch).toHaveBeenLastCalledWith("/api/convex-token/orb", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } })

    await orb.fetch("/api/me")
    const headers = (fetch.mock.lastCall as unknown as [string, RequestInit])[1].headers as Headers
    expect(headers.get("Authorization")).toBe(`Bearer ${accessToken}`)
  })

  it("signs out: tells Orb, and doesn't sign the same profile back in on the next context update", async () => {
    const orb = createOrbAuth()
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
    await orb.signOut()
    expect(client().disconnect).toHaveBeenCalledOnce()
    expect(orb.getState()).toMatchObject({ status: "signed-out", account: null })
    client().emit(contextFor(ALICE))
    expect(host.connect).toHaveBeenCalledOnce()
    expect(orb.getState().status).toBe("signed-out")
  })

  it("drops a silent sign-in that finishes after it was stopped, and tries again on the next start", async () => {
    let answer!: (tokens: unknown) => void
    host.connect = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const orb = createOrbAuth()
    const stop = orb.start()
    stop()
    answer(tokensFor(ALICE))
    await vi.waitFor(() => expect(host.connect).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(orb.getState().status).not.toBe("signed-in")
    expect(await orb.fetchConvexToken()).toBeNull()

    host.connect = vi.fn(async () => tokensFor(ALICE))
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
  })

  it("survives being started twice (React Strict Mode) with one silent sign-in", async () => {
    const orb = createOrbAuth()
    const stop = orb.start()
    stop()
    orb.start()
    await vi.waitFor(() => expect(orb.getState().status).toBe("signed-in"))
    expect(host.connect).toHaveBeenCalledOnce()
    expect(host.clients).toHaveLength(1)
  })
})
