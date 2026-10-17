// @vitest-environment jsdom
import * as React from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OrbAuthSource, OrbSessionState } from "../src/orb/types"

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// What Convex's provider got from useAuth, as the last render saw it
const convexAuth = vi.hoisted(() => ({ current: null as null | { isLoading: boolean; isAuthenticated: boolean; fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null> } }))

vi.mock("thirdweb/react", () => ({
  ThirdwebProvider: ({ children }: { children: React.ReactNode }) => children,
  AutoConnect: () => null,
  useActiveAccount: () => undefined,
  useActiveWallet: () => undefined,
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock("@lens-protocol/react", () => ({ LensProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({ useAuth, children }: { useAuth: () => NonNullable<typeof convexAuth.current>; children: React.ReactNode }) => {
    convexAuth.current = useAuth()
    return children
  },
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}))

import { LensAuthProvider, useLensAuth } from "../src/react/provider"
import type { LensAuth } from "../src/core/auth"

// A stored-session-free wallet auth: the provider only reads it here
const auth = {
  storagePrefix: "test_",
  getSession: () => null,
  resumeSession: vi.fn(async () => false),
  logout: vi.fn(async () => ({ revoked: true })),
  fetchConvexToken: vi.fn(async () => "wallet-convex-token"),
  tokens: { getStoredTokens: () => null, refreshTokens: vi.fn() },
} as unknown as LensAuth

// An Orb source whose state each test drives
function fakeOrb(inside: boolean) {
  const listeners = new Set<() => void>()
  let state: OrbSessionState = { status: "loading", account: null, sessionId: 0, error: null }
  const set = (patch: Partial<OrbSessionState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const orb = {
    isInsideOrb: () => inside,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => state,
    start: vi.fn(() => () => {}),
    signIn: vi.fn(async () => set({ status: "signed-in", account: { address: ALICE, username: "alice" }, sessionId: state.sessionId + 1 })),
    signOut: vi.fn(async () => set({ status: "signed-out", account: null })),
    fetchConvexToken: vi.fn(async () => "orb-convex-token"),
  } satisfies OrbAuthSource
  return { orb, set }
}

function renderAuth(props: Partial<React.ComponentProps<typeof LensAuthProvider>> = {}) {
  return renderHook(() => useLensAuth(), {
    wrapper: ({ children }) => (
      <LensAuthProvider auth={auth} convex={{} as never} {...props}>
        {children}
      </LensAuthProvider>
    ),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  convexAuth.current = null
})

describe("<LensAuthProvider orb>", () => {
  it("signs in with a wallet as before without `orb`", async () => {
    const { result } = renderAuth()
    await waitFor(() => expect(result.current.status).toBe("signed-out"))
    expect(result.current.method).toBe("wallet")
    expect(result.current.orb).toBeNull()
  })

  it("keeps the wallet sign-in outside Orb, without starting Orb's", async () => {
    const { orb } = fakeOrb(false)
    const { result } = renderAuth({ orb })
    await waitFor(() => expect(result.current.status).toBe("signed-out"))
    expect(result.current.method).toBe("wallet")
    expect(result.current.orb).toBeNull()
    expect(orb.start).not.toHaveBeenCalled()
  })

  it("signs in with the Orb profile inside Orb, and Convex as the same account", async () => {
    const { orb, set } = fakeOrb(true)
    const onSignIn = vi.fn()
    const onAccountChange = vi.fn()
    const { result } = renderAuth({ orb, onSignIn, onAccountChange })
    await waitFor(() => expect(result.current.method).toBe("orb"))
    expect(orb.start).toHaveBeenCalled()
    expect(result.current.status).toBe("loading")
    expect(convexAuth.current?.isLoading).toBe(true)

    act(() => set({ status: "signed-out" }))
    expect(result.current.status).toBe("signed-out")
    expect(result.current.orb).toMatchObject({ signingIn: false, error: null })

    await act(() => result.current.orb!.signIn())
    expect(result.current.status).toBe("signed-in")
    expect(result.current.account).toEqual({ address: ALICE, username: "alice" })
    expect(convexAuth.current?.isAuthenticated).toBe(true)
    expect(await convexAuth.current!.fetchAccessToken({ forceRefreshToken: false })).toBe("orb-convex-token")
    expect(auth.fetchConvexToken).not.toHaveBeenCalled()
    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith({ address: ALICE, username: "alice" }))
    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith(null, { address: ALICE, username: "alice" }))

    let signedOut: { revoked: boolean } | undefined
    await act(async () => {
      signedOut = await result.current.signOut()
    })
    expect(orb.signOut).toHaveBeenCalled()
    expect(auth.logout).not.toHaveBeenCalled()
    expect(signedOut).toEqual({ revoked: false })
    expect(result.current.status).toBe("signed-out")
    expect(convexAuth.current?.isAuthenticated).toBe(false)
  })

  it("passes on why an Orb sign-in failed", async () => {
    const { orb, set } = fakeOrb(true)
    const { result } = renderAuth({ orb })
    await waitFor(() => expect(result.current.method).toBe("orb"))
    act(() => set({ status: "signing-in" }))
    expect(result.current.orb?.signingIn).toBe(true)
    act(() => set({ status: "signed-out", error: "Sign-in was declined in Orb." }))
    expect(result.current.orb).toMatchObject({ signingIn: false, error: "Sign-in was declined in Orb." })
  })
})
