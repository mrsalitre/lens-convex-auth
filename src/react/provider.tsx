import * as React from "react"
import { LensProvider } from "@lens-protocol/react"
import { ThirdwebProvider, useActiveAccount, useActiveWallet, useDisconnect } from "thirdweb/react"
import type { Account as ThirdwebAccount, Wallet } from "thirdweb/wallets"
import { ConvexProviderWithAuth, useConvexAuth, type ConvexReactClient } from "convex/react"
import type { LensAuth } from "../core/auth"
import { TOKENS_CHANGED_EVENT } from "../core/tokens"

export type SignedInAccount = {
  /** Lens account address, lowercased */
  address: string
  /** Lens username (local name), when known */
  username: string | null
}

export type LensAuthStatus =
  /** Reading the stored session (first render, and during SSR) */
  | "loading"
  /** No wallet and no Lens session */
  | "signed-out"
  /** Wallet connected, no Lens account signed in yet: the account dialog should be open (see useAccountDialog) */
  | "choosing-account"
  /** Signed in to a Lens account (Convex is authenticated as it too) */
  | "signed-in"

export type LensAuthContextValue = {
  auth: LensAuth
  status: LensAuthStatus
  isLoading: boolean
  isSignedIn: boolean
  /** The connected thirdweb wallet account */
  wallet: ThirdwebAccount | undefined
  /** The signed-in Lens account */
  account: SignedInAccount | null
  /**
   * Ends the Lens session and disconnects the wallet. The session is revoked on the Lens API, so its tokens
   * stop working even if they were copied; `revoked` is false when that failed (the session is cleared
   * from this browser either way).
   */
  signOut: () => Promise<{ revoked: boolean }>
  /** Opens the account dialog, e.g. to switch to another account */
  openAccountDialog: () => void
}

// Whether the account dialog should show. The package doesn't draw one: render your own around
// useAccountPicker() and useCreateAccount(), or <AccountDialog /> from lens-convex-auth/react/ui.
export type AccountDialogControls = {
  open: boolean
  /** True while a wallet is connected without a Lens session: the dialog can't be dismissed */
  required: boolean
  /** Closing does nothing while it's required */
  setOpen: (open: boolean) => void
}

// What the account hooks need besides the controls. Internal: not exported from the package.
type AccountDialogState = AccountDialogControls & {
  /** Call before authenticating as the account, so its username shows as soon as its session is stored */
  selectAccount: (account: SignedInAccount) => void
  completeSignIn: (account: SignedInAccount) => void
  /** Counts a mounted user of the dialog's state, so the provider can tell when nothing shows the dialog */
  register: () => () => void
}

const LensAuthContext = React.createContext<LensAuthContextValue | null>(null)
const AccountDialogContext = React.createContext<AccountDialogState | null>(null)

export function useLensAuth(): LensAuthContextValue {
  const ctx = React.useContext(LensAuthContext)
  if (!ctx) throw new Error("useLensAuth must be used within <LensAuthProvider>")
  return ctx
}

export function useAccountDialogState(): AccountDialogState {
  const ctx = React.useContext(AccountDialogContext)
  if (!ctx) throw new Error("The account dialog's hooks must be used within <LensAuthProvider>")
  const register = ctx.register
  React.useEffect(() => register(), [register])
  return ctx
}

// Whether to show the account dialog, which picks or creates the Lens account to sign in with. It opens by
// itself when a wallet connects without a Lens session, and with openAccountDialog() to switch accounts.
export function useAccountDialog(): AccountDialogControls {
  const { open, required, setOpen } = useAccountDialogState()
  return { open, required, setOpen }
}

function subscribeToTokens(onChange: () => void) {
  window.addEventListener(TOKENS_CHANGED_EVENT, onChange)
  // Signing in or out in another tab
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(TOKENS_CHANGED_EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

// Identifies the stored Lens session: its id plus the account it acts for. Token refreshes keep it the
// same; signing in again, or as another account, changes it. Undefined until read on the client.
function useSessionKey(auth: LensAuth): string | null | undefined {
  return React.useSyncExternalStore(
    subscribeToTokens,
    () => {
      const session = auth.getSession()
      return session ? `${session.sessionId}:${session.account}` : null
    },
    () => undefined,
  )
}

// Signs Convex in as the Lens account the user signed in with. A new session gets a new
// fetchAccessToken, which makes Convex fetch its token again.
function createUseConvexAuth(auth: LensAuth) {
  return function useLensConvexAuth() {
    const sessionKey = useSessionKey(auth)
    const fetchAccessToken = React.useCallback(
      async ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
        sessionKey ? auth.fetchConvexToken(forceRefreshToken) : null,
      [sessionKey],
    )
    return { isLoading: sessionKey === undefined, isAuthenticated: !!sessionKey, fetchAccessToken }
  }
}

export type LensAuthProviderProps = {
  /** From createLensAuth(), created once at module level */
  auth: LensAuth
  /** Your ConvexReactClient. Omit to use the package without Convex. */
  convex?: ConvexReactClient
  /**
   * Called after the user signs in from the account dialog (picking an account or creating one), once
   * Convex accepts the session. A good place to create the user's row: `convex.mutation(api.users.ensure)`
   */
  onSignIn?: (account: SignedInAccount) => unknown
  /**
   * Called when the signed-in Lens account changes, however it happens: signing in, switching accounts,
   * logging out, or the session ending (it expired, or another tab logged out). Not called when a stored
   * session is restored on load. A good place to delete data your app keeps in the browser for `previous`.
   */
  onAccountChange?: (previous: SignedInAccount | null, next: SignedInAccount | null) => unknown
  /**
   * Wallets to reconnect after a reload while a Lens session is stored. Pass the same list as
   * SignInButton's `connectButtonProps.wallets`, if you customize it. Defaults to thirdweb's wallets.
   */
  wallets?: Wallet[]
  children: React.ReactNode
}

// thirdweb's AutoConnect (loaded on demand, like the ConnectButton) reconnects the last wallet
const AutoConnect = React.lazy(() => import("thirdweb/react").then((m) => ({ default: m.AutoConnect })))

// Wraps the app in thirdweb, Lens and (optionally) Convex providers wired to one session. It renders no UI:
// add <AccountDialog /> from lens-convex-auth/react/ui inside it, or your own dialog (see useAccountDialog).
export function LensAuthProvider({ auth, convex, onSignIn, onAccountChange, wallets, children }: LensAuthProviderProps) {
  const [useConvexAuthHook] = React.useState(() => createUseConvexAuth(auth))
  const content = (
    <LensAuthState auth={auth} onSignIn={onSignIn} onAccountChange={onAccountChange} withConvex={!!convex} wallets={wallets}>
      {children}
    </LensAuthState>
  )
  return (
    <ThirdwebProvider>
      <LensProvider client={auth.lensClient}>
        {convex ? (
          <ConvexProviderWithAuth client={convex} useAuth={useConvexAuthHook}>
            {content}
          </ConvexProviderWithAuth>
        ) : content}
      </LensProvider>
    </ThirdwebProvider>
  )
}

function readSelectedAccount(auth: LensAuth, address: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(`${auth.storagePrefix}account`) ?? "null")
    return stored?.address === address && typeof stored.username === "string" ? stored.username : null
  } catch {
    return null
  }
}

function writeSelectedAccount(auth: LensAuth, account: SignedInAccount | null) {
  try {
    const key = `${auth.storagePrefix}account`
    if (account) localStorage.setItem(key, JSON.stringify(account))
    else localStorage.removeItem(key)
  } catch {}
}

function LensAuthState({ auth, onSignIn, onAccountChange, withConvex, wallets, children }: {
  auth: LensAuth
  onSignIn?: LensAuthProviderProps["onSignIn"]
  onAccountChange?: LensAuthProviderProps["onAccountChange"]
  withConvex: boolean
  wallets?: Wallet[]
  children: React.ReactNode
}) {
  const wallet = useActiveAccount()
  const activeWallet = useActiveWallet()
  const { disconnect } = useDisconnect()
  const sessionKey = useSessionKey(auth)
  const [manualOpen, setManualOpen] = React.useState(false)
  const [pendingSignIn, setPendingSignIn] = React.useState<SignedInAccount | null>(null)
  // How many mounted components use the dialog's state (see useNoDialogWarning)
  const dialogUsers = React.useRef(0)
  const register = React.useCallback(() => {
    dialogUsers.current++
    return () => {
      dialogUsers.current--
    }
  }, [])
  // The account being signed in to from the dialog. Its session is stored (and read back as sessionKey)
  // before completeSignIn saves it, so without this the account would show without its username.
  const [selected, setSelected] = React.useState<SignedInAccount | null>(null)

  const account = React.useMemo<SignedInAccount | null>(() => {
    if (!sessionKey) return null
    const address = sessionKey.slice(sessionKey.lastIndexOf(":") + 1)
    const username = selected?.address === address ? selected.username : readSelectedAccount(auth, address)
    return { address, username }
  }, [auth, sessionKey, selected])

  const status: LensAuthStatus =
    sessionKey === undefined ? "loading"
    : sessionKey ? "signed-in"
    : wallet ? "choosing-account"
    : "signed-out"

  useBackgroundRefresh(auth)
  useAccountChange(status, account, onAccountChange)
  useNoDialogWarning(status, dialogUsers)

  // A connected wallet checks the stored session is still valid (refreshing it or clearing it)
  React.useEffect(() => {
    if (wallet) void auth.resumeSession().catch(() => {})
  }, [auth, wallet?.address])

  const signOut = React.useCallback(async () => {
    setManualOpen(false)
    setSelected(null)
    writeSelectedAccount(auth, null)
    // Both clear their state synchronously (logout before its first await), so the next render sees
    // neither. A wallet left without a session would open the account dialog while logout() waits on
    // the network, and a session left without a wallet would reconnect it (see AutoConnect below).
    if (activeWallet) disconnect(activeWallet)
    return auth.logout()
  }, [auth, activeWallet, disconnect])

  const value = React.useMemo<LensAuthContextValue>(() => ({
    auth,
    status,
    isLoading: status === "loading",
    isSignedIn: status === "signed-in",
    wallet,
    account,
    signOut,
    openAccountDialog: () => setManualOpen(true),
  }), [auth, status, wallet, account, signOut])

  const required = status === "choosing-account"
  const dialog = React.useMemo<AccountDialogState>(() => ({
    open: required || (manualOpen && !!wallet),
    required,
    register,
    selectAccount: setSelected,
    setOpen: (open) => {
      if (open) setManualOpen(true)
      else if (!required) setManualOpen(false)
    },
    completeSignIn: (signedIn) => {
      setSelected(signedIn)
      writeSelectedAccount(auth, signedIn)
      setManualOpen(false)
      if (onSignIn) setPendingSignIn(signedIn)
    },
  }), [auth, required, manualOpen, wallet, onSignIn, register])

  return (
    <LensAuthContext.Provider value={value}>
      <AccountDialogContext.Provider value={dialog}>
        {children}
        {/* After a reload the Lens session is restored from storage, but the wallet only comes back if
            something reconnects it: SignInButton's ConnectButton does, but it's only shown while no
            wallet is connected and apps often hide it once signed in. */}
        {sessionKey && !wallet && (
          <React.Suspense fallback={null}>
            <AutoConnect client={auth.thirdwebClient} chain={auth.chain} wallets={wallets} />
          </React.Suspense>
        )}
        {pendingSignIn && onSignIn && (
          withConvex
            ? <ConvexSignInCallback account={pendingSignIn} onSignIn={onSignIn} done={() => setPendingSignIn(null)} />
            : <SignInCallback account={pendingSignIn} onSignIn={onSignIn} done={() => setPendingSignIn(null)} />
        )}
      </AccountDialogContext.Provider>
    </LensAuthContext.Provider>
  )
}

type SignInCallbackProps = {
  account: SignedInAccount
  onSignIn: NonNullable<LensAuthProviderProps["onSignIn"]>
  done: () => void
}

function SignInCallback({ account, onSignIn, done }: SignInCallbackProps) {
  React.useEffect(() => {
    Promise.resolve(onSignIn(account)).catch((err) => console.error("lens-convex-auth: onSignIn failed", err)).finally(done)
  }, [account])
  return null
}

// Waits until Convex accepts the new session, so onSignIn can call authenticated Convex functions
function ConvexSignInCallback(props: SignInCallbackProps) {
  const { isAuthenticated, isLoading } = useConvexAuth()
  return isAuthenticated && !isLoading ? <SignInCallback {...props} /> : null
}

// Calls onAccountChange when the signed-in account changes, from the first account known after loading
function useAccountChange(
  status: LensAuthStatus,
  account: SignedInAccount | null,
  onAccountChange: LensAuthProviderProps["onAccountChange"],
) {
  const last = React.useRef<SignedInAccount | null | undefined>(undefined)
  const callback = React.useRef(onAccountChange)
  React.useEffect(() => {
    callback.current = onAccountChange
  })
  const loading = status === "loading"
  const address = account?.address ?? null
  React.useEffect(() => {
    if (loading) return
    const previous = last.current
    last.current = account
    if (previous === undefined || (previous?.address ?? null) === address) return
    Promise.resolve()
      .then(() => callback.current?.(previous, account))
      .catch((err) => console.error("lens-convex-auth: onAccountChange failed", err))
    // Only the address counts: the username arriving for the same account isn't a change
  }, [loading, address])
}

// The provider draws no dialog, so an app that renders none (say, after upgrading from 0.4, when the provider
// drew one) leaves a connected wallet with no way to pick an account. Says so in development.
function useNoDialogWarning(status: LensAuthStatus, dialogUsers: React.RefObject<number>) {
  React.useEffect(() => {
    if (status !== "choosing-account" || isProduction()) return
    const timeout = setTimeout(() => {
      if (dialogUsers.current > 0) return
      console.warn(
        "lens-convex-auth: a wallet connected without a Lens session, but nothing shows the account dialog to pick " +
          "an account. Add <AccountDialog /> from lens-convex-auth/react/ui inside <LensAuthProvider>, or your own " +
          "built on useAccountDialog().",
      )
    }, 1000)
    return () => clearTimeout(timeout)
  }, [status, dialogUsers])
}

// Written exactly as bundlers look for it, so they replace it; the try covers code that runs unbundled
function isProduction() {
  try {
    return process.env.NODE_ENV === "production"
  } catch {
    return false
  }
}

// Refreshes the tokens a minute before they expire, so Convex and API calls always have a fresh one
function useBackgroundRefresh(auth: LensAuth) {
  React.useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    // Runs again whenever tokens are stored or cleared (a sign-in, a refresh, another tab)
    const schedule = () => {
      if (timeout) clearTimeout(timeout)
      timeout = undefined
      const tokens = auth.tokens.getStoredTokens()
      if (stopped || !tokens?.expiresAt) return
      const delay = Math.max(1000, tokens.expiresAt - Date.now() - 60 * 1000)
      timeout = setTimeout(() => void auth.tokens.refreshTokens(), delay)
    }

    const unsubscribe = subscribeToTokens(schedule)
    ;(async () => {
      try {
        await auth.resumeSession()
      } catch {}
      schedule()
    })()

    return () => {
      stopped = true
      unsubscribe()
      if (timeout) clearTimeout(timeout)
    }
  }, [auth])
}
