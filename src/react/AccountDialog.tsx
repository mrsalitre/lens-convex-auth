import * as React from "react"
import { useAccountsAvailable } from "@lens-protocol/react"
import { evmAddress, type Account, type AccountAvailable } from "@lens-protocol/client"
import type { Account as ThirdwebAccount } from "thirdweb/wallets"
import { Loader2 } from "lucide-react"
import { CHALLENGE_MAX_AGE_MS, CHALLENGE_REFRESH_MS, opensWalletWithDeepLink, type LensAuth, type LensChallenge } from "../core/auth"
import { fetchAccountUsername } from "../core/onboarding"
import { useAccountDialogState, useLensAuth } from "./provider"
import { CreateAccountForm, type CreatedAccount } from "./CreateAccountForm"
import { useMediaQuery } from "./dom"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "./ui/drawer"

// Lists the wallet's Lens accounts to sign in with, or the form to create one. Opens by itself when a
// wallet connects without a Lens session, and can't be dismissed until an account is signed in to (or
// the wallet disconnects). A dialog on desktop, a drawer on mobile.
export function AccountDialog() {
  const { wallet, signOut } = useLensAuth()
  const { open, required, setOpen } = useAccountDialogState()
  const isDesktop = useMediaQuery("(min-width: 768px)")
  const [creating, setCreating] = React.useState(false)

  // Show the account list again the next time the dialog opens
  React.useEffect(() => {
    if (!open) setCreating(false)
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (!next && required) return
    setOpen(next)
  }

  const body = wallet
    ? <AccountDialogBody key={wallet.address} wallet={wallet} creating={creating} setCreating={setCreating} />
    : null
  const disconnect = (
    <Button onClick={signOut} variant="outline" className="w-full">
      Disconnect Wallet
    </Button>
  )

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="sm:max-w-[425px] max-h-[80vh] overflow-y-auto"
          showCloseButton={!required}
          onEscapeKeyDown={(e) => required && e.preventDefault()}
          onPointerDownOutside={(e) => required && e.preventDefault()}
        >
          {body}
          <div className="mt-4">{disconnect}</div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} dismissible={!required}>
      <DrawerContent className="max-h-[80vh] overflow-y-auto">
        {body}
        <div className="p-4">{disconnect}</div>
      </DrawerContent>
    </Drawer>
  )
}

function AccountDialogBody({ wallet, creating, setCreating }: {
  wallet: ThirdwebAccount
  creating: boolean
  setCreating: (creating: boolean) => void
}) {
  const { auth } = useLensAuth()
  const { completeSignIn } = useAccountDialogState()
  const isDesktop = useMediaQuery("(min-width: 768px)")
  const { data, loading: loadingAccounts } = useAccountsAvailable({ managedBy: evmAddress(wallet.address), includeOwned: true })
  const accounts = data?.items
  const usernames = useAccountUsernames(auth, accounts)
  const loading = loadingAccounts || (!!accounts && !usernames)
  const usernameOf = React.useCallback((acc: Account) => {
    const resolved = usernames?.[acc.address.toLowerCase()]
    return resolved === undefined ? acc.username?.localName ?? null : resolved
  }, [usernames])
  // Accounts without a username aren't listed, so they don't count
  const hasAccounts = !loading && !!accounts?.some((item) => usernameOf(item.account))
  // Wallets without an account go straight to creating one
  const showCreate = creating || (!loading && !hasAccounts)

  const signIn = async (account: SelectableAccount, challenge: LensChallenge) => {
    // The signature request goes out before the first await, so a click handler calling this keeps its
    // user gesture, which mobile wallets need to open (see signLensChallenge).
    const signature = await auth.signChallenge(challenge, wallet)
    await auth.authenticate(challenge, signature)
    completeSignIn({ address: account.address.toLowerCase(), username: usernameOf(account) })
  }

  const handleCreated = async (created: CreatedAccount) => {
    completeSignIn({ address: created.address.toLowerCase(), username: created.localName })
  }

  const title = showCreate ? "Create Account" : "Select Account"
  const description = showCreate
    ? hasAccounts ? "Pick a username for your new Lens account." : "You don’t have a Lens account yet. Create one to continue."
    : "Select an account to continue."

  const Header = isDesktop ? DialogHeader : DrawerHeader
  const Title = isDesktop ? DialogTitle : DrawerTitle
  const Description = isDesktop ? DialogDescription : DrawerDescription

  return (
    <>
      <Header className={isDesktop ? undefined : "text-left"}>
        <Title>{title}</Title>
        <Description>{description}</Description>
      </Header>
      <div className={isDesktop || !showCreate ? undefined : "px-4"}>
        {showCreate ? (
          <CreateAccountForm
            ownerAddress={wallet.address}
            onCreated={handleCreated}
            onBack={hasAccounts ? () => setCreating(false) : undefined}
          />
        ) : (
          <AccountList auth={auth} accounts={accounts} usernameOf={usernameOf} loading={loading} ownerAddress={wallet.address} onSign={signIn} onCreate={() => setCreating(true)} />
        )}
      </div>
    </>
  )
}

// Each account's username by lowercased address (see fetchAccountUsername), or undefined while they load.
// An account whose lookup failed is left out, so it falls back to its global Lens username.
function useAccountUsernames(auth: LensAuth, accounts?: readonly AccountAvailable[]) {
  const key = accounts?.map((item) => item.account.address.toLowerCase()).join(",")
  const [usernames, setUsernames] = React.useState<{ key: string; byAddress: Record<string, string | null> } | null>(null)

  React.useEffect(() => {
    if (key === undefined) return
    let cancelled = false
    const addresses = key ? key.split(",") : []
    Promise.all(addresses.map((address) =>
      fetchAccountUsername(auth, address).then((username) => [[address, username] as const], () => []),
    )).then((entries) => {
      if (!cancelled) setUsernames({ key, byAddress: Object.fromEntries(entries.flat()) })
    })
    return () => {
      cancelled = true
    }
  }, [auth, key])

  return usernames && usernames.key === key ? usernames.byAddress : undefined
}

type SelectableAccount = Account & { isOwner: boolean }

type SignInStep =
  | { id: string; status: "loading" }
  | { id: string; status: "sign"; challenge: LensChallenge }

type PrefetchedChallenge = { owner: string; challenge: LensChallenge; fetchedAt: number }

function fetchChallenge(auth: LensAuth, acc: SelectableAccount, ownerAddress: string) {
  return auth.requestChallenge({
    role: acc.isOwner ? "ACCOUNT_OWNER" : "ACCOUNT_MANAGER",
    account: acc.address,
    signer: ownerAddress,
  })
}

function AccountList({ auth, accounts, usernameOf, loading, ownerAddress, onSign, onCreate }: {
  auth: LensAuth
  accounts?: readonly AccountAvailable[]
  usernameOf: (account: Account) => string | null
  loading: boolean
  ownerAddress: string
  onSign: (account: SelectableAccount, challenge: LensChallenge) => Promise<void>
  onCreate: () => void
}) {
  const [step, setStep] = React.useState<SignInStep | null>(null)
  const [errorId, setErrorId] = React.useState<string | null>(null)
  const [challenges, setChallenges] = React.useState<Record<string, PrefetchedChallenge>>({})

  const selectable = React.useMemo(() => (accounts ?? []).map((item, index) => {
    const acc: SelectableAccount = { ...item.account, isOwner: item.__typename === "AccountOwned" }
    return { acc, id: `${acc.address}-${index}` }
  }), [accounts])

  const prefetch = React.useCallback((acc: SelectableAccount, id: string) => {
    fetchChallenge(auth, acc, ownerAddress)
      .then((challenge) => setChallenges((prev) => ({ ...prev, [id]: { owner: ownerAddress, challenge, fetchedAt: Date.now() } })))
      .catch(() => {})
  }, [auth, ownerAddress])

  // Fetch each account's challenge ahead of time, so a tap can ask the wallet to sign right away:
  // on mobile that tap is what lets the wallet app open (see opensWalletWithDeepLink).
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      for (const { acc, id } of selectable) {
        if (usernameOf(acc)) prefetch(acc, id)
      }
    }
    refresh()
    const interval = setInterval(refresh, CHALLENGE_REFRESH_MS)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [selectable, usernameOf, prefetch])

  const readyChallenge = (id: string) => {
    if (step?.id === id && step.status === "sign") return step.challenge
    const prefetched = challenges[id]
    if (!prefetched || prefetched.owner !== ownerAddress) return null
    return Date.now() - prefetched.fetchedAt < CHALLENGE_MAX_AGE_MS ? prefetched.challenge : null
  }

  const handleClick = (acc: SelectableAccount, id: string) => {
    setErrorId(null)
    const fail = () => {
      setStep(null)
      setErrorId(id)
      prefetch(acc, id)
    }
    const challenge = readyChallenge(id)
    if (challenge) {
      // Sign now, while the tap still counts as a user gesture. A challenge can only be used once.
      const signing = onSign(acc, challenge)
      setChallenges(({ [id]: _used, ...rest }) => rest)
      setStep({ id, status: "loading" })
      signing.then(() => setStep(null), fail)
      return
    }
    // The challenge isn't ready yet: fetch it now. Desktop wallets sign without a user gesture;
    // on mobile it takes one more tap to open the wallet.
    setStep({ id, status: "loading" })
    ;(async () => {
      const fetched = await fetchChallenge(auth, acc, ownerAddress)
      if (opensWalletWithDeepLink()) return setStep({ id, status: "sign", challenge: fetched })
      await onSign(acc, fetched)
      setStep(null)
    })().catch(fail)
  }

  if (loading) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">Loading available profiles…</p>
      </div>
    )
  }

  return (
    <div className="py-4 space-y-3">
      <ul className="space-y-2 max-h-80 overflow-y-auto">
        {selectable.map(({ acc, id }) => {
          const username = usernameOf(acc)
          if (!username) return null
          const isLoading = step?.id === id && step.status === "loading"
          const awaitingSignature = step?.id === id && step.status === "sign"
          return (
            <li key={id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 rounded-md border hover:bg-accent/50 flex items-center justify-between cursor-pointer disabled:cursor-default"
                onClick={() => handleClick(acc, id)}
                disabled={step?.status === "loading"}
              >
                <span className="truncate">{username}</span>
                {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                {awaitingSignature && <span className="text-sm font-medium text-primary">Sign in</span>}
              </button>
              {awaitingSignature && (
                <p className="px-1 pt-1 text-xs text-muted-foreground">Tap again to sign the message in your wallet.</p>
              )}
              {errorId === id && (
                <p className="px-1 pt-1 text-xs text-destructive">Couldn’t sign in. Please try again.</p>
              )}
            </li>
          )
        })}
      </ul>
      <Button variant="ghost" className="w-full" onClick={onCreate} disabled={step?.status === "loading"}>
        Create a new account
      </Button>
    </div>
  )
}
