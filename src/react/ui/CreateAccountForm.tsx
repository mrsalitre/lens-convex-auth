import * as React from "react"
import { Check, Loader2 } from "lucide-react"
import { useCreateAccount, type CreateAccountStep } from "../useCreateAccount"
import { cn } from "./utils"
import { Button } from "./primitives/button"
import { Input } from "./primitives/input"
import { Textarea } from "./primitives/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "./primitives/avatar"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./primitives/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./primitives/input-group"

const STEP_LABELS = {
    signing: "Waiting for signature…",
    "tap-again": "Sign in wallet",
    checking: "Checking username…",
    uploading: "Uploading profile…",
    creating: "Creating account…",
    "signing-in": "Signing in…",
} satisfies Record<CreateAccountStep, string>

// Creates a Lens account for the connected wallet and signs in to it: a username, and optionally a picture,
// a name and a bio. Built on useCreateAccount(), which you can use for a form of your own.
export function CreateAccountForm({ onBack, actions }: {
    /** Shows "Back to your accounts", for wallets that have some */
    onBack?: () => void
    /** More buttons, shown under the form's own */
    actions?: React.ReactNode
}) {
    const form = useCreateAccount()
    const { username, usernameStatus, picture, pictureUrl, step, busy, error } = form
    const pictureInput = React.useRef<HTMLInputElement>(null)

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        form.submit()
    }

    const handlePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] ?? null
        e.target.value = ""
        form.setPicture(file)
    }

    const usernameMessage = (() => {
        switch (usernameStatus.status) {
            case "invalid":
            case "taken":
            case "rejected":
                return { text: usernameStatus.message, isError: true }
            case "checking": return { text: "Checking availability…", isError: false }
            case "available": return { text: "Available", isError: false }
            default: return null
        }
    })()

    const fallbackInitial = (form.name.trim() || username || "?").charAt(0).toUpperCase()

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
                                <Button type="button" variant="ghost" size="sm" onClick={() => form.setPicture(null)} disabled={busy}>
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
                            onChange={(e) => form.setUsername(e.target.value)}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            aria-invalid={usernameMessage?.isError || undefined}
                            aria-describedby="create-account-username-status"
                            disabled={busy}
                        />
                        <InputGroupAddon align="inline-end">
                            {usernameStatus.status === "checking" && username && <Loader2 className="animate-spin" />}
                            {usernameStatus.status === "available" && <Check />}
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
                    <Input id="create-account-name" value={form.name} onChange={(e) => form.setName(e.target.value)} maxLength={100} disabled={busy} />
                </Field>

                <Field>
                    <FieldLabel htmlFor="create-account-bio">
                        Bio <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Textarea
                        id="create-account-bio"
                        value={form.bio}
                        onChange={(e) => form.setBio(e.target.value)}
                        maxLength={300}
                        rows={3}
                        className="resize-none"
                        disabled={busy}
                    />
                </Field>

                <Field className="gap-2">
                    <Button type="submit" className="w-full" disabled={busy}>
                        {busy && <Loader2 className="animate-spin" />}
                        {step ? STEP_LABELS[step] : "Create account"}
                    </Button>
                    <FieldDescription aria-live="polite" className={cn("min-h-5 leading-5", error && "text-destructive")}>
                        {error ?? (step === "tap-again" ? "Tap again to sign in your wallet." : "You’ll sign a message in your wallet. It’s free.")}
                    </FieldDescription>
                    {onBack && (
                        <Button type="button" variant="ghost" className="w-full" onClick={onBack} disabled={busy}>
                            Back to your accounts
                        </Button>
                    )}
                    {actions}
                </Field>
            </FieldGroup>
        </form>
    )
}
