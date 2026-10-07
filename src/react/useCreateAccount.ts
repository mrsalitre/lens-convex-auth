import * as React from "react"
import { useActiveWallet } from "thirdweb/react"
import type { SessionClient } from "@lens-protocol/client"
import { CHALLENGE_MAX_AGE_MS, CHALLENGE_REFRESH_MS, opensWalletWithDeepLink, signLensChallenge, type LensChallenge } from "../core/auth"
import {
  OnboardingError,
  authenticateOnboarding,
  checkUsername,
  createLensAccount,
  createOnboardingClient,
  isUsernameTaken,
  requestOnboardingChallenge,
  signInToCreatedAccount,
  uploadAccountMetadata,
  usernameFormatError,
} from "../core/onboarding"
import { useAccountDialogState, useLensAuth } from "./provider"

/**
 * Where creating the account is. "tap-again": the challenge arrived after the tap, and on mobile it takes
 * another tap to open the wallet, so call submit() again.
 */
export type CreateAccountStep = "signing" | "tap-again" | "checking" | "uploading" | "creating" | "signing-in"

export type UsernameStatus =
  /** "pending": typed, waiting for typing to pause before it's checked; "checking": the check is running */
  | { status: "empty" | "pending" | "checking" | "available" }
  /** The availability check failed: submitting checks again */
  | { status: "unknown" }
  /** "invalid": the format is wrong; "taken"; "rejected": Lens turned it down on submit */
  | { status: "invalid" | "taken" | "rejected"; message: string }

export type CreateAccountState = {
  username: string
  /** Trims and lowercases it, as usernames are */
  setUsername: (username: string) => void
  /** Checked as typing pauses */
  usernameStatus: UsernameStatus
  /** Optional, like the bio and picture: leave out the fields you don't ask for */
  name: string
  setName: (name: string) => void
  bio: string
  setBio: (bio: string) => void
  picture: File | null
  /** An object URL for a preview of the picture, revoked when it changes */
  pictureUrl: string | null
  /** Pictures over 10 MB are refused, with `error` saying so */
  setPicture: (picture: File | null) => void
  step: CreateAccountStep | null
  /** Creating the account: disable the inputs. False at "tap-again", which waits for the user. */
  busy: boolean
  error: string | null
  /**
   * Creates the account and signs in to it. Call it straight from the submit handler: on mobile the tap is
   * what lets the wallet app open. A retry after a failure doesn't sign again or create a second account.
   */
  submit: () => void
}

const USERNAME_DEBOUNCE_MS = 300
const MAX_PICTURE_BYTES = 10 * 1024 * 1024

type Created = { address: string; localName: string }

// Creates a Lens account for the connected wallet, with a username in your app's namespace, and signs in to
// it. The state for a form of your own.
export function useCreateAccount(): CreateAccountState {
  const { auth, wallet: activeAccount } = useLensAuth()
  const { selectAccount, completeSignIn } = useAccountDialogState()
  const wallet = useActiveWallet()
  const owner = activeAccount?.address ?? null

  const [client] = React.useState(() => createOnboardingClient(auth))
  // Kept across attempts so a retry doesn't ask for another signature or create a second account
  const session = React.useRef<SessionClient | null>(null)
  const created = React.useRef<Created | null>(null)
  // Counts wallet changes. A submit remembers the count it started with, and once the wallet has changed it
  // stops touching state, so the previous wallet's flow can't show up in (or sign in) the next one's form.
  const run = React.useRef(0)

  const [username, setUsernameValue] = React.useState("")
  const [debouncedUsername, setDebouncedUsername] = React.useState("")
  const [name, setName] = React.useState("")
  const [bio, setBio] = React.useState("")
  const [picture, setPictureValue] = React.useState<File | null>(null)
  const [pictureUrl, setPictureUrl] = React.useState<string | null>(null)

  const [availability, setAvailability] = React.useState<{ localName: string; status: "checking" | "available" | "taken" | "unknown" } | null>(null)
  const [rejected, setRejected] = React.useState<{ localName: string; message: string } | null>(null)
  const [step, setStep] = React.useState<{ status: Exclude<CreateAccountStep, "tap-again"> } | { status: "tap-again"; challenge: LensChallenge } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [prefetched, setPrefetched] = React.useState<{ challenge: LensChallenge; fetchedAt: number } | null>(null)

  // The onboarding session, and what was typed, belong to the wallet: another wallet starts over. Ending the
  // session when the form is left (or the wallet changes) before the account is signed in to.
  React.useEffect(() => {
    return () => {
      run.current++
      if (!created.current) void session.current?.logout()
      session.current = null
      created.current = null
      setUsernameValue("")
      setDebouncedUsername("")
      setName("")
      setBio("")
      setPictureValue(null)
      setAvailability(null)
      setRejected(null)
      setStep(null)
      setError(null)
      setPrefetched(null)
    }
  }, [owner])

  // Fetch the challenge ahead of time, so the tap on submit can ask the wallet to sign right away:
  // on mobile that tap is what lets the wallet app open (see opensWalletWithDeepLink).
  React.useEffect(() => {
    if (!owner) return
    const refresh = () => {
      if (document.visibilityState !== "visible" || session.current) return
      requestOnboardingChallenge(auth, client, owner)
        .then((challenge) => setPrefetched({ challenge, fetchedAt: Date.now() }))
        .catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, CHALLENGE_REFRESH_MS)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [auth, client, owner])

  React.useEffect(() => {
    if (!picture) return setPictureUrl(null)
    const url = URL.createObjectURL(picture)
    setPictureUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [picture])

  // Only check the username once typing pauses, not on every keystroke
  React.useEffect(() => {
    const timeout = setTimeout(() => setDebouncedUsername(username), USERNAME_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [username])

  React.useEffect(() => {
    if (!debouncedUsername || usernameFormatError(debouncedUsername)) return
    let cancelled = false
    setAvailability({ localName: debouncedUsername, status: "checking" })
    isUsernameTaken(auth, debouncedUsername)
      .then((taken) => !cancelled && setAvailability({ localName: debouncedUsername, status: taken ? "taken" : "available" }))
      .catch(() => !cancelled && setAvailability({ localName: debouncedUsername, status: "unknown" }))
    return () => {
      cancelled = true
    }
  }, [auth, debouncedUsername])

  const usernameStatus = describeUsername(username, availability, rejected)
  const busy = step !== null && step.status !== "tap-again"

  const fail = (current: () => boolean) => (e: unknown) => {
    if (!current()) return
    setStep(null)
    if ((e as Error)?.name === "UnauthenticatedError") session.current = null
    setError(e instanceof OnboardingError ? e.message : "Couldn’t create your account. Please try again.")
  }

  const create = async (onboarding: SessionClient, current: () => boolean) => {
    const localName = username
    if (!created.current) {
      setStep({ status: "checking" })
      const reason = await checkUsername(auth, onboarding, localName)
      if (!current()) return
      if (reason) {
        setRejected({ localName, message: reason })
        setStep(null)
        return
      }
      setStep({ status: "uploading" })
      const metadataUri = await uploadAccountMetadata(auth, { name: name.trim(), bio: bio.trim(), picture })
      if (!current()) return
      setStep({ status: "creating" })
      if (!wallet) throw new OnboardingError("Connect your wallet")
      const account = await createLensAccount(auth, onboarding, wallet, { localName, metadataUri })
      if (!current()) return
      // account.username is its global Lens username, which it has none of in the app's namespace
      created.current = { address: account.address, localName }
    }
    const { address } = created.current
    setStep({ status: "signing-in" })
    const signedIn = { address: address.toLowerCase(), username: created.current.localName }
    selectAccount(signedIn)
    await signInToCreatedAccount(auth, onboarding, address)
    if (!current()) return
    setStep(null)
    completeSignIn(signedIn)
  }

  const continueWith = (authenticating: Promise<SessionClient | null>, current: () => boolean) => {
    authenticating
      .then(async (onboarding) => {
        if (!onboarding || !current()) return
        session.current = onboarding
        await create(onboarding, current)
      })
      .catch(fail(current))
  }

  const readyChallenge = () => {
    if (step?.status === "tap-again") return step.challenge
    if (!prefetched || Date.now() - prefetched.fetchedAt >= CHALLENGE_MAX_AGE_MS) return null
    return prefetched.challenge
  }

  const submit = () => {
    if (busy || !activeAccount || !owner) return
    if (!username) return setRejected({ localName: username, message: "Choose a username" })
    if (usernameStatus.status === "invalid" || usernameStatus.status === "taken") return
    setError(null)
    setRejected(null)
    const started = run.current
    const current = () => run.current === started

    if (session.current) {
      setStep({ status: "checking" })
      create(session.current, current).catch(fail(current))
      return
    }

    const challenge = readyChallenge()
    if (challenge) {
      // Sign now, while the tap still counts as a user gesture. A challenge can only be used once.
      const signing = signLensChallenge(challenge, activeAccount)
      setPrefetched(null)
      setStep({ status: "signing" })
      continueWith(signing.then((signature) => authenticateOnboarding(client, challenge, signature)), current)
      return
    }

    // The challenge isn't ready yet: fetch it now. Desktop wallets sign without a user gesture;
    // on mobile it takes one more tap to open the wallet.
    setStep({ status: "signing" })
    continueWith((async () => {
      const fetched = await requestOnboardingChallenge(auth, client, owner)
      if (!current()) return null
      if (opensWalletWithDeepLink()) {
        setStep({ status: "tap-again", challenge: fetched })
        return null
      }
      const signature = await signLensChallenge(fetched, activeAccount)
      return authenticateOnboarding(client, fetched, signature)
    })(), current)
  }

  const setUsername = React.useCallback((value: string) => setUsernameValue(value.trim().toLowerCase()), [])

  const setPicture = React.useCallback((file: File | null) => {
    if (file && file.size > MAX_PICTURE_BYTES) return setError("Choose a picture under 10 MB")
    setError(null)
    setPictureValue(file)
  }, [])

  return {
    username,
    setUsername,
    usernameStatus,
    name,
    setName,
    bio,
    setBio,
    picture,
    pictureUrl,
    setPicture,
    step: step?.status ?? null,
    busy,
    error,
    submit,
  }
}

// What to say about the username as typed, from its format, the last availability check and Lens's answer
export function describeUsername(
  username: string,
  availability: { localName: string; status: "checking" | "available" | "taken" | "unknown" } | null,
  rejected: { localName: string; message: string } | null,
): UsernameStatus {
  if (rejected?.localName === username) return { status: "rejected", message: rejected.message }
  if (!username) return { status: "empty" }
  const formatError = usernameFormatError(username)
  if (formatError) return { status: "invalid", message: formatError }
  // No check for this exact username yet: it starts once typing pauses
  if (availability?.localName !== username) return { status: "pending" }
  if (availability.status === "taken") return { status: "taken", message: "This username is taken" }
  return { status: availability.status }
}
