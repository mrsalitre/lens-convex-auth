import * as React from "react"
import { useActiveAccount, useActiveWallet } from "thirdweb/react"
import type { SessionClient } from "@lens-protocol/client"
import { Check, Loader2 } from "lucide-react"
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
import { useLensAuth } from "./provider"
import { cn } from "./utils"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Textarea } from "./ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group"

export type CreatedAccount = { address: string; localName: string }

type Step =
    | { status: "signing" }
    // The challenge arrived after the tap: on mobile it takes one more tap to open the wallet
    | { status: "sign"; challenge: LensChallenge }
    | { status: "checking" | "uploading" | "creating" | "signing-in" }

const STEP_LABELS = {
    signing: "Waiting for signature…",
    sign: "Sign in wallet",
    checking: "Checking username…",
    uploading: "Uploading profile…",
    creating: "Creating account…",
    "signing-in": "Signing in…",
} satisfies Record<Step["status"], string>

type Availability = { localName: string; status: "checking" | "available" | "taken" | "unknown" }

// Same delay as the search on the find page
const USERNAME_DEBOUNCE_MS = 300
const MAX_PICTURE_BYTES = 10 * 1024 * 1024

// Render with `key={ownerAddress}`: the onboarding session belongs to the wallet that signed it.
export function CreateAccountForm({ ownerAddress, onCreated, onBack }: {
    ownerAddress: string
    onCreated: (account: CreatedAccount) => Promise<void>
    onBack?: () => void
}) {
    const { auth } = useLensAuth()
    const activeAccount = useActiveAccount()
    const wallet = useActiveWallet()

    const [client] = React.useState(() => createOnboardingClient(auth))
    // Kept across attempts so a retry doesn't ask for another signature or create a second account
    const session = React.useRef<SessionClient | null>(null)
    const created = React.useRef<CreatedAccount | null>(null)
    const pictureInput = React.useRef<HTMLInputElement>(null)

    const [username, setUsername] = React.useState("")
    const [debouncedUsername, setDebouncedUsername] = React.useState("")
    const [name, setName] = React.useState("")
    const [bio, setBio] = React.useState("")
    const [picture, setPicture] = React.useState<File | null>(null)
    const [pictureUrl, setPictureUrl] = React.useState<string | null>(null)

    const [availability, setAvailability] = React.useState<Availability | null>(null)
    const [usernameError, setUsernameError] = React.useState<{ localName: string; message: string } | null>(null)
    const [step, setStep] = React.useState<Step | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [prefetched, setPrefetched] = React.useState<{ challenge: LensChallenge; fetchedAt: number } | null>(null)

    const formatError = username ? usernameFormatError(username) : null
    const busy = step !== null && step.status !== "sign"

    // Fetch the challenge ahead of time, so the tap on "Create account" can ask the wallet to sign right
    // away: on mobile that tap is what lets the wallet app open (see opensWalletWithDeepLink).
    React.useEffect(() => {
        const refresh = () => {
            if (document.visibilityState !== "visible" || session.current) return
            requestOnboardingChallenge(auth, client, ownerAddress)
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
    }, [auth, client, ownerAddress])

    // End the onboarding session if the form is left before the account is signed in to
    React.useEffect(() => () => {
        if (!created.current) void session.current?.logout()
    }, [])

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

    const fail = (e: unknown) => {
        setStep(null)
        if ((e as Error)?.name === "UnauthenticatedError") session.current = null
        setError(e instanceof OnboardingError ? e.message : "Couldn’t create your account. Please try again.")
    }

    const create = async (onboarding: SessionClient) => {
        const localName = username
        if (!created.current) {
            setStep({ status: "checking" })
            const reason = await checkUsername(auth, onboarding, localName)
            if (reason) {
                setUsernameError({ localName, message: reason })
                setStep(null)
                return
            }
            setStep({ status: "uploading" })
            const metadataUri = await uploadAccountMetadata(auth, { name: name.trim(), bio: bio.trim(), picture })
            setStep({ status: "creating" })
            if (!wallet) throw new OnboardingError("Connect your wallet")
            const account = await createLensAccount(auth, onboarding, wallet, { localName, metadataUri })
            // account.username is its global Lens username, which it has none of in the app's namespace
            created.current = { address: account.address, localName }
        }
        setStep({ status: "signing-in" })
        await signInToCreatedAccount(auth, onboarding, created.current.address)
        await onCreated(created.current)
    }

    const continueWith = (authenticating: Promise<SessionClient | null>) => {
        authenticating
            .then(async (onboarding) => {
                if (!onboarding) return
                session.current = onboarding
                await create(onboarding)
            })
            .catch(fail)
    }

    const readyChallenge = () => {
        if (step?.status === "sign") return step.challenge
        if (!prefetched || Date.now() - prefetched.fetchedAt >= CHALLENGE_MAX_AGE_MS) return null
        return prefetched.challenge
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (busy || !activeAccount) return
        if (!username) return setUsernameError({ localName: username, message: "Choose a username" })
        if (formatError || availability?.status === "taken") return
        setError(null)
        setUsernameError(null)

        if (session.current) {
            setStep({ status: "checking" })
            create(session.current).catch(fail)
            return
        }

        const challenge = readyChallenge()
        if (challenge) {
            // Sign now, while the tap still counts as a user gesture. A challenge can only be used once.
            const signing = signLensChallenge(challenge, activeAccount)
            setPrefetched(null)
            setStep({ status: "signing" })
            continueWith(signing.then((signature) => authenticateOnboarding(client, challenge, signature)))
            return
        }

        // The challenge isn't ready yet: fetch it now. Desktop wallets sign without a user gesture;
        // on mobile it takes one more tap to open the wallet.
        setStep({ status: "signing" })
        continueWith((async () => {
            const fetched = await requestOnboardingChallenge(auth, client, ownerAddress)
            if (opensWalletWithDeepLink()) {
                setStep({ status: "sign", challenge: fetched })
                return null
            }
            const signature = await signLensChallenge(fetched, activeAccount)
            return authenticateOnboarding(client, fetched, signature)
        })())
    }

    const handlePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] ?? null
        e.target.value = ""
        if (file && file.size > MAX_PICTURE_BYTES) return setError("Choose a picture under 10 MB")
        setError(null)
        setPicture(file)
    }

    const usernameMessage = (() => {
        if (formatError) return { text: formatError, isError: true }
        if (usernameError?.localName === username) return { text: usernameError.message, isError: true }
        if (availability?.localName !== username) return null
        switch (availability.status) {
            case "checking": return { text: "Checking availability…", isError: false }
            case "available": return { text: "Available", isError: false }
            case "taken": return { text: "This username is taken", isError: true }
            default: return null
        }
    })()

    const fallbackInitial = (name.trim() || username || "?").charAt(0).toUpperCase()
    const usernameStatus = availability?.localName === username && !formatError ? availability.status : null

    return (
        <form className="py-4" onSubmit={handleSubmit} noValidate>
            <FieldGroup className="gap-5">
                <Field orientation="horizontal">
                    <Avatar className="size-16">
                        {pictureUrl && <AvatarImage src={pictureUrl} alt="" className="object-cover" />}
                        <AvatarFallback className="text-lg font-semibold">{fallbackInitial}</AvatarFallback>
                    </Avatar>
                    <FieldContent>
                        <FieldLabel htmlFor="create-account-picture">
                            Profile picture <span className="font-normal text-muted-foreground">(optional)</span>
                        </FieldLabel>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => pictureInput.current?.click()} disabled={busy}>
                                {picture ? "Change" : "Add photo"}
                            </Button>
                            {picture && (
                                <Button type="button" variant="ghost" size="sm" onClick={() => setPicture(null)} disabled={busy}>
                                    Remove
                                </Button>
                            )}
                        </div>
                    </FieldContent>
                    <input
                        ref={pictureInput}
                        id="create-account-picture"
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={handlePictureChange}
                        disabled={busy}
                    />
                </Field>

                <Field data-invalid={usernameMessage?.isError || undefined}>
                    <FieldLabel htmlFor="create-account-username">Username</FieldLabel>
                    <InputGroup>
                        <InputGroupAddon>
                            <InputGroupText>@</InputGroupText>
                        </InputGroupAddon>
                        <InputGroupInput
                            id="create-account-username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value.trim().toLowerCase())}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            aria-invalid={usernameMessage?.isError || undefined}
                            aria-describedby="create-account-username-status"
                            disabled={busy}
                        />
                        <InputGroupAddon align="inline-end">
                            {usernameStatus === "checking" && <Loader2 className="animate-spin" />}
                            {usernameStatus === "available" && <Check />}
                        </InputGroupAddon>
                    </InputGroup>
                    {/* Always rendered with a fixed height, so the form doesn't shift as the feedback changes */}
                    <FieldDescription
                        id="create-account-username-status"
                        aria-live="polite"
                        className={cn("min-h-5 leading-5", usernameMessage?.isError && "text-destructive")}
                    >
                        {usernameMessage?.text}
                    </FieldDescription>
                </Field>

                <Field>
                    <FieldLabel htmlFor="create-account-name">
                        Name <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Input id="create-account-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={busy} />
                </Field>

                <Field>
                    <FieldLabel htmlFor="create-account-bio">
                        Bio <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Textarea
                        id="create-account-bio"
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        maxLength={300}
                        rows={3}
                        className="resize-none"
                        disabled={busy}
                    />
                </Field>

                <Field className="gap-2">
                    <Button type="submit" className="w-full" disabled={busy || !activeAccount}>
                        {busy && <Loader2 className="animate-spin" />}
                        {step ? STEP_LABELS[step.status] : "Create account"}
                    </Button>
                    <FieldDescription aria-live="polite" className={cn("min-h-5 leading-5", error && "text-destructive")}>
                        {error ?? (step?.status === "sign" ? "Tap again to sign in your wallet." : "You’ll sign a message in your wallet. It’s free.")}
                    </FieldDescription>
                    {onBack && (
                        <Button type="button" variant="ghost" className="w-full" onClick={onBack} disabled={busy}>
                            Back to your accounts
                        </Button>
                    )}
                </Field>
            </FieldGroup>
        </form>
    )
}
