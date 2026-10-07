// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// What the mocked provider gives the hooks; each test sets it up, and rerenders after changing it
// Lens checks addresses, so these are real-looking ones
const WALLET = "0x1111111111111111111111111111111111111111"
const OTHER_WALLET = "0x2222222222222222222222222222222222222222"
const ALICE = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc"
const NEW_ACCOUNT = "0x3333333333333333333333333333333333333333"
const usernames: Record<string, string> = { [ALICE.toLowerCase()]: "alice", [BOB.toLowerCase()]: "bob", [CAROL]: "carol" }

const state = vi.hoisted(() => ({
  open: true,
  wallet: undefined as { address: string } | undefined,
  auth: {} as Record<string, unknown>,
  selectAccount: (() => {}) as (account: unknown) => void,
  completeSignIn: (() => {}) as (account: unknown) => void,
}))

vi.mock("../src/react/provider", () => ({
  useLensAuth: () => ({ auth: state.auth, wallet: state.wallet }),
  useAccountDialogState: () => ({
    open: state.open,
    required: false,
    setOpen: () => {},
    register: () => () => {},
    selectAccount: state.selectAccount,
    completeSignIn: state.completeSignIn,
  }),
}))
vi.mock("thirdweb/react", () => ({ useActiveWallet: () => ({ id: "wallet" }) }))
vi.mock("@lens-protocol/client/actions", () => ({ fetchAccountsAvailable: vi.fn() }))
vi.mock("../src/core/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/auth")>()),
  opensWalletWithDeepLink: vi.fn(() => false),
  signLensChallenge: vi.fn(),
}))
vi.mock("../src/core/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/onboarding")>()),
  fetchAccountUsername: vi.fn(),
  createOnboardingClient: vi.fn(() => ({})),
  requestOnboardingChallenge: vi.fn(),
  authenticateOnboarding: vi.fn(),
  isUsernameTaken: vi.fn(),
  checkUsername: vi.fn(),
  uploadAccountMetadata: vi.fn(),
  createLensAccount: vi.fn(),
  signInToCreatedAccount: vi.fn(),
}))

import { fetchAccountsAvailable } from "@lens-protocol/client/actions"
import { opensWalletWithDeepLink, signLensChallenge } from "../src/core/auth"
import * as onboarding from "../src/core/onboarding"
import { useAccountPicker } from "../src/react/useAccountPicker"
import { useCreateAccount } from "../src/react/useCreateAccount"

const items = [
  { __typename: "AccountOwned", account: { address: ALICE, username: { localName: "alice" } } },
  { __typename: "AccountManaged", account: { address: BOB, username: { localName: "bob" } } },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.open = true
  state.wallet = { address: WALLET }
  state.selectAccount = vi.fn()
  state.completeSignIn = vi.fn()
  state.auth = {
    lensClient: {},
    requestChallenge: vi.fn(async () => ({ id: "challenge", text: "sign this" })),
    signChallenge: vi.fn(async () => "signature"),
    authenticate: vi.fn(async () => {}),
  }
  vi.mocked(fetchAccountsAvailable).mockImplementation((() =>
    Promise.resolve({ isOk: () => true, value: { items } })) as never)
  vi.mocked(onboarding.fetchAccountUsername).mockImplementation(async (_auth, address) => usernames[address] ?? null)
  vi.mocked(opensWalletWithDeepLink).mockReturnValue(false)
})

describe("useAccountPicker", () => {
  it("doesn't reach Lens while the dialog is closed", async () => {
    state.open = false
    const { result, rerender } = renderHook(() => useAccountPicker())
    await act(async () => {})
    expect(fetchAccountsAvailable).not.toHaveBeenCalled()
    expect(state.auth.requestChallenge).not.toHaveBeenCalled()
    expect(result.current.status).toBe("loading")

    state.open = true
    rerender()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.accounts.map((account) => account.username)).toEqual(["alice", "bob"])
    // One challenge per account, fetched ahead of the tap
    await waitFor(() => expect(state.auth.requestChallenge).toHaveBeenCalledTimes(2))
  })

  it("fetches the list again each time the dialog opens, so new accounts show", async () => {
    const { result, rerender } = renderHook(() => useAccountPicker())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetchAccountsAvailable).toHaveBeenCalledTimes(1)

    state.open = false
    rerender()
    const created = { __typename: "AccountOwned", account: { address: CAROL, username: { localName: "carol" } } }
    vi.mocked(fetchAccountsAvailable).mockImplementation((() =>
      Promise.resolve({ isOk: () => true, value: { items: [...items, created] } })) as never)
    state.open = true
    rerender()

    await waitFor(() => expect(result.current.accounts.map((account) => account.username)).toEqual(["alice", "bob", "carol"]))
    expect(fetchAccountsAvailable).toHaveBeenCalledTimes(2)
  })

  it("on mobile, a challenge that arrives after the tap takes a second tap to sign", async () => {
    vi.mocked(opensWalletWithDeepLink).mockReturnValue(true)
    const requestChallenge = state.auth.requestChallenge as ReturnType<typeof vi.fn>
    // The ahead-of-time challenges never arrive
    requestChallenge.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useAccountPicker())
    await waitFor(() => expect(result.current.status).toBe("ready"))

    requestChallenge.mockImplementation(async () => ({ id: "late", text: "sign this" }))
    act(() => result.current.signIn(result.current.accounts[0]))
    await waitFor(() => expect(result.current.accounts[0].state).toBe("tap-again"))
    expect(state.auth.signChallenge).not.toHaveBeenCalled()

    act(() => result.current.signIn(result.current.accounts[0]))
    await waitFor(() => expect(state.completeSignIn).toHaveBeenCalledWith({ address: ALICE.toLowerCase(), username: "alice" }))
    expect(state.auth.signChallenge).toHaveBeenCalledWith({ id: "late", text: "sign this" }, state.wallet)
    expect(result.current.accounts[0].state).toBe("idle")
  })
})

describe("useCreateAccount", () => {
  beforeEach(() => {
    vi.mocked(onboarding.requestOnboardingChallenge).mockResolvedValue({ id: "onboarding", text: "sign this" } as never)
    vi.mocked(signLensChallenge).mockResolvedValue("signature" as never)
    vi.mocked(onboarding.authenticateOnboarding).mockResolvedValue({ logout: vi.fn() } as never)
    vi.mocked(onboarding.isUsernameTaken).mockResolvedValue(false)
    vi.mocked(onboarding.checkUsername).mockResolvedValue(null)
    vi.mocked(onboarding.uploadAccountMetadata).mockResolvedValue("lens://metadata")
    vi.mocked(onboarding.createLensAccount).mockResolvedValue({ address: NEW_ACCOUNT } as never)
    vi.mocked(onboarding.signInToCreatedAccount).mockResolvedValue()
  })

  // Waits for the challenge fetched ahead of time, so submit signs with it
  async function renderForm() {
    const rendered = renderHook(() => useCreateAccount())
    await waitFor(() => expect(onboarding.requestOnboardingChallenge).toHaveBeenCalled())
    await act(async () => {})
    act(() => rendered.result.current.setUsername("  Alice "))
    return rendered
  }

  it("creates the account and signs in to it", async () => {
    const { result } = await renderForm()
    expect(result.current.username).toBe("alice")
    act(() => result.current.submit())
    await waitFor(() => expect(state.completeSignIn).toHaveBeenCalledWith({ address: NEW_ACCOUNT, username: "alice" }))
    expect(result.current.step).toBe(null)
  })

  it("retries after a failure without signing again or creating a second account", async () => {
    vi.mocked(onboarding.signInToCreatedAccount).mockRejectedValueOnce(new Error("network"))
    const { result } = await renderForm()

    act(() => result.current.submit())
    await waitFor(() => expect(result.current.error).toBe("Couldn’t create your account. Please try again."))
    expect(state.completeSignIn).not.toHaveBeenCalled()

    act(() => result.current.submit())
    await waitFor(() => expect(state.completeSignIn).toHaveBeenCalledTimes(1))
    expect(signLensChallenge).toHaveBeenCalledTimes(1)
    expect(onboarding.createLensAccount).toHaveBeenCalledTimes(1)
    expect(onboarding.signInToCreatedAccount).toHaveBeenCalledTimes(2)
  })

  it("drops a flow from the previous wallet, and starts the next one's form over", async () => {
    const creating = deferred<{ address: string }>()
    vi.mocked(onboarding.createLensAccount).mockReturnValue(creating.promise as never)
    const { result, rerender } = await renderForm()

    act(() => result.current.submit())
    await waitFor(() => expect(result.current.step).toBe("creating"))

    state.wallet = { address: OTHER_WALLET }
    rerender()
    await act(async () => creating.resolve({ address: NEW_ACCOUNT }))

    expect(state.completeSignIn).not.toHaveBeenCalled()
    expect(onboarding.signInToCreatedAccount).not.toHaveBeenCalled()
    expect(result.current.step).toBe(null)
    expect(result.current.username).toBe("")
  })
})
