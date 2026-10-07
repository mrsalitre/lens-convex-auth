import * as React from "react"
import { evmAddress, type AccountAvailable } from "@lens-protocol/client"
import { fetchAccountsAvailable } from "@lens-protocol/client/actions"
import { CHALLENGE_MAX_AGE_MS, CHALLENGE_REFRESH_MS, opensWalletWithDeepLink, type LensAuth, type LensChallenge } from "../core/auth"
import { fetchAccountUsername } from "../core/onboarding"
import { useAccountDialogState, useLensAuth } from "./provider"

export type PickerAccount = {
  /** Unique in the list: one address can be listed twice, owned and managed */
  id: string
  address: string
  /** The account's username in your app's namespace, or its global Lens one */
  username: string
  /** The wallet owns the account, rather than managing it */
  isOwner: boolean
  /** Another account in the list has the same username (in another namespace): show its address too */
  sharesUsername: boolean
  /**
   * "signing-in" while the wallet signs and Lens authenticates. "tap-again" when the challenge arrived after
   * the tap: on mobile it takes another tap to open the wallet, so call signIn again. "failed" after an error.
   */
  state: "idle" | "signing-in" | "tap-again" | "failed"
}

export type AccountPickerState = {
  /** "no-wallet" until a wallet connects; "loading" while its accounts and their usernames load */
  status: "no-wallet" | "loading" | "ready"
  /** The wallet's Lens accounts that have a username. Empty when it has none: offer to create one. */
  accounts: PickerAccount[]
  /** A sign-in is in progress: disable the other accounts */
  busy: boolean
  /**
   * Signs in to the account. Call it straight from the click handler: the signature request goes out before
   * the first await, which keeps the tap's user gesture, and on mobile that's what lets the wallet app open.
   */
  signIn: (account: PickerAccount) => void
}

type Step = { id: string; status: "loading" } | { id: string; status: "sign"; challenge: LensChallenge }

type PrefetchedChallenge = { owner: string; challenge: LensChallenge; fetchedAt: number }

// The wallet's Lens accounts to sign in with, for an account list of your own. The connected wallet signs.
// It only reaches Lens while the account dialog is open (see useAccountDialog), fetching the list again each
// time it opens, so it can live in a component that stays mounted.
export function useAccountPicker(): AccountPickerState {
  const { auth, wallet } = useLensAuth()
  const { open, selectAccount, completeSignIn } = useAccountDialogState()
  const owner = wallet?.address ?? null
  const available = useAvailableAccounts(auth, owner, open)
  const usernames = useAccountUsernames(auth, available)

  const [step, setStep] = React.useState<Step | null>(null)
  const [errorId, setErrorId] = React.useState<string | null>(null)
  const [challenges, setChallenges] = React.useState<Record<string, PrefetchedChallenge>>({})

  // A sign-in in progress belongs to the wallet that started it
  React.useEffect(() => {
    setStep(null)
    setErrorId(null)
  }, [owner])

  const listed = React.useMemo(() => {
    if (!available || !usernames) return []
    return listAccounts(available, usernames)
  }, [available, usernames])

  const fetchChallenge = React.useCallback(
    (account: { address: string; isOwner: boolean }) =>
      auth.requestChallenge({ role: account.isOwner ? "ACCOUNT_OWNER" : "ACCOUNT_MANAGER", account: account.address, signer: owner! }),
    [auth, owner],
  )

  const prefetch = React.useCallback((account: { id: string; address: string; isOwner: boolean }) => {
    if (!owner) return
    fetchChallenge(account)
      .then((challenge) => setChallenges((prev) => ({ ...prev, [account.id]: { owner, challenge, fetchedAt: Date.now() } })))
      .catch(() => {})
  }, [fetchChallenge, owner])

  // Fetch each account's challenge ahead of time, so a tap can ask the wallet to sign right away:
  // on mobile that tap is what lets the wallet app open (see opensWalletWithDeepLink). Only while it's open.
  React.useEffect(() => {
    if (!open) return
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      for (const account of listed) prefetch(account)
    }
    refresh()
    const interval = setInterval(refresh, CHALLENGE_REFRESH_MS)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [open, listed, prefetch])

  const readyChallenge = (id: string) => {
    if (step?.id === id && step.status === "sign") return step.challenge
    const prefetched = challenges[id]
    if (!prefetched || prefetched.owner !== owner) return null
    return Date.now() - prefetched.fetchedAt < CHALLENGE_MAX_AGE_MS ? prefetched.challenge : null
  }

  const signIn = (account: PickerAccount) => {
    if (!wallet || step?.status === "loading") return
    setErrorId(null)
    const signInWith = async (challenge: LensChallenge) => {
      // Requests the signature before its first await (see above)
      const signature = await auth.signChallenge(challenge, wallet)
      const signedIn = { address: account.address.toLowerCase(), username: account.username }
      selectAccount(signedIn)
      await auth.authenticate(challenge, signature)
      completeSignIn(signedIn)
    }
    const fail = () => {
      setStep(null)
      setErrorId(account.id)
      prefetch(account)
    }

    const challenge = readyChallenge(account.id)
    if (challenge) {
      // Sign now, while the tap still counts as a user gesture. A challenge can only be used once.
      const signing = signInWith(challenge)
      setChallenges(({ [account.id]: _used, ...rest }) => rest)
      setStep({ id: account.id, status: "loading" })
      signing.then(() => setStep(null), fail)
      return
    }
    // The challenge isn't ready yet: fetch it now. Desktop wallets sign without a user gesture;
    // on mobile it takes one more tap to open the wallet.
    setStep({ id: account.id, status: "loading" })
    ;(async () => {
      const fetched = await fetchChallenge(account)
      if (opensWalletWithDeepLink()) return setStep({ id: account.id, status: "sign", challenge: fetched })
      await signInWith(fetched)
      setStep(null)
    })().catch(fail)
  }

  const accounts = listed.map((account): PickerAccount => ({
    ...account,
    state:
      step?.id === account.id ? (step.status === "loading" ? "signing-in" : "tap-again")
      : errorId === account.id ? "failed"
      : "idle",
  }))

  return {
    status: !owner ? "no-wallet" : !available || !usernames ? "loading" : "ready",
    accounts,
    busy: step?.status === "loading",
    signIn,
  }
}

// The accounts the wallet owns or manages, or undefined until they first load (and without a wallet). Fetched
// again each time the dialog opens, so accounts created since show up; the last list stays until then.
function useAvailableAccounts(auth: LensAuth, owner: string | null, open: boolean) {
  const [loaded, setLoaded] = React.useState<{ owner: string; items: readonly AccountAvailable[] } | null>(null)

  React.useEffect(() => {
    if (!owner || !open) return
    let cancelled = false
    fetchAccountsAvailable(auth.lensClient, { managedBy: evmAddress(owner), includeOwned: true }).then((result) => {
      // A failed lookup lists no accounts, which offers to create one
      if (!cancelled) setLoaded({ owner, items: result.isOk() ? result.value.items : [] })
    })
    return () => {
      cancelled = true
    }
  }, [auth, owner, open])

  return loaded && loaded.owner === owner ? loaded.items : undefined
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

type ListedAccount = Omit<PickerAccount, "state">

// The accounts to show: those with a username, flagging usernames that more than one of them has
export function listAccounts(
  available: readonly Pick<AccountAvailable, "__typename" | "account">[],
  usernames: Record<string, string | null>,
): ListedAccount[] {
  const withUsernames = available.flatMap((item, index) => {
    const address = item.account.address
    const resolved = usernames[address.toLowerCase()]
    const username = resolved === undefined ? item.account.username?.localName ?? null : resolved
    if (!username) return []
    return [{ id: `${address}-${index}`, address, username, isOwner: item.__typename === "AccountOwned" }]
  })
  const counts = new Map<string, number>()
  for (const { username } of withUsernames) counts.set(username, (counts.get(username) ?? 0) + 1)
  return withUsernames.map((account) => ({ ...account, sharesUsername: counts.get(account.username)! > 1 }))
}
