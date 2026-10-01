import * as React from "react"
import { LensProvider } from "@lens-protocol/react"
import { ThirdwebProvider, useActiveAccount, useActiveWallet, useDisconnect } from "thirdweb/react"
import type { Account as ThirdwebAccount, Wallet } from "thirdweb/wallets"
import { ConvexProviderWithAuth, useConvexAuth, type ConvexReactClient } from "convex/react"
import type { LensAuth } from "../core/auth"
import { TOKENS_CHANGED_EVENT } from "../core/tokens"
import { AccountDialog } from "./AccountDialog"

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
  /** Wallet connected, no Lens account signed in yet: the account dialog is open */
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
  /** Ends the Lens session and disconnects the wallet */
  signOut: () => Promise<void>
  /** Opens the account dialog, e.g. to switch to another account */
  openAccountDialog: () => void
}

export type AccountDialogHeader = {
  /** "Select Account", or "Create Account" while the form to create one is shown */
  title: string
  description: string
}

export type AccountDialogControls = AccountDialogHeader & {
  open: boolean
  /** True while a wallet is connected without a Lens session: the dialog can't be dismissed */
  required: boolean
  setOpen: (open: boolean) => void
}

type AccountDialogState = AccountDialogControls & {
  setHeader: (header: AccountDialogHeader) => void
  completeSignIn: (account: SignedInAccount) => void
}

const DEFAULT_HEADER: AccountDialogHeader = { title: "Select Account", description: "Select an account to continue." }

const LensAuthContext = React.createContext<LensAuthContextValue | null>(null)
const AccountDialogContext = React.createContext<AccountDialogState | null>(null)

export function useLensAuth(): LensAuthContextValue {
  const ctx = React.useContext(LensAuthContext)
  if (!ctx) throw new Error("useLensAuth must be used within <LensAuthProvider>")
  return ctx
}

export function useAccountDialogState(): AccountDialogState {
  const ctx = React.useContext(AccountDialogContext)
  if (!ctx) throw new Error("<AccountDialog> must be used within <LensAuthProvider>")
  return ctx
}

// The account dialog's state, to render <AccountPicker /> in your own dialog (with accountDialog={false})
export function useAccountDialog(): AccountDialogControls {
  const { open, required, setOpen, title, description } = useAccountDialogState()
  return { open, required, setOpen, title, description }
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
  onSignIn?: (account: SignedInAccount) => void | Promise<void>
  /** Render the account dialog. Set to false to render <AccountDialog /> yourself. Defaults to true. */
  accountDialog?: boolean
  /**
   * Wallets to reconnect after a reload while a Lens session is stored. Pass the same list as
   * SignInButton's `connectButtonProps.wallets`, if you customize it. Defaults to thirdweb's wallets.
   */
  wallets?: Wallet[]
  children: React.ReactNode
}

// thirdweb's AutoConnect (loaded on demand, like the ConnectButton) reconnects the last wallet
const AutoConnect = React.lazy(() => import("thirdweb/react").then((m) => ({ default: m.AutoConnect })))

// Wraps the app in thirdweb, Lens and (optionally) Convex providers wired to one session.
export function LensAuthProvider({ auth, convex, onSignIn, accountDialog = true, wallets, children }: LensAuthProviderProps) {
  const [useConvexAuthHook] = React.useState(() => createUseConvexAuth(auth))
  const content = (
    <LensAuthState auth={auth} onSignIn={onSignIn} withConvex={!!convex} wallets={wallets}>
      {children}
      {accountDialog && <AccountDialog />}
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

function LensAuthState({ auth, onSignIn, withConvex, wallets, children }: {
  auth: LensAuth
  onSignIn?: LensAuthProviderProps["onSignIn"]
  withConvex: boolean
  wallets?: Wallet[]
  children: React.ReactNode
}) {
  const wallet = useActiveAccount()
  const activeWallet = useActiveWallet()
  const { disconnect } = useDisconnect()
  const sessionKey = useSessionKey(auth)
  const [manualOpen, setManualOpen] = React.useState(false)
  const [header, setHeader] = React.useState(DEFAULT_HEADER)
  const [pendingSignIn, setPendingSignIn] = React.useState<SignedInAccount | null>(null)

  const account = React.useMemo<SignedInAccount | null>(() => {
    if (!sessionKey) return null
    const address = sessionKey.slice(sessionKey.lastIndexOf(":") + 1)
    return { address, username: readSelectedAccount(auth, address) }
  }, [auth, sessionKey])

  const status: LensAuthStatus =
    sessionKey === undefined ? "loading"
    : sessionKey ? "signed-in"
    : wallet ? "choosing-account"
    : "signed-out"

  useBackgroundRefresh(auth)

  // A connected wallet checks the stored session is still valid (refreshing it or clearing it)
  React.useEffect(() => {
    if (wallet) void auth.resumeSession().catch(() => {})
  }, [auth, wallet?.address])

  const signOut = React.useCallback(async () => {
    setManualOpen(false)
    writeSelectedAccount(auth, null)
    // Both clear their state synchronously (logout before its first await), so the next render sees
    // neither. A wallet left without a session would open the account dialog while logout() waits on
    // the network, and a session left without a wallet would reconnect it (see AutoConnect below).
    if (activeWallet) disconnect(activeWallet)
    await auth.logout()
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
    ...header,
    setHeader,
    setOpen: (open) => {
      if (open) setManualOpen(true)
      else if (!required) setManualOpen(false)
    },
    completeSignIn: (signedIn) => {
      writeSelectedAccount(auth, signedIn)
      setManualOpen(false)
      if (onSignIn) setPendingSignIn(signedIn)
    },
  }), [auth, required, manualOpen, wallet, header, onSignIn])

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
