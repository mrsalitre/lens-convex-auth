import * as React from "react"
import { Loader2 } from "lucide-react"
import { useAccountDialog, useLensAuth } from "../provider"
import { useAccountPicker } from "../useAccountPicker"
import { CreateAccountForm } from "./CreateAccountForm"
import { useMediaQuery } from "./dom"
import { Button } from "./primitives/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./primitives/dialog"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "./primitives/drawer"

export type AccountPickerHeader = {
  /** "Select Account", or "Create Account" while the form to create one is shown */
  title: string
  description: string
}

const DEFAULT_HEADER: AccountPickerHeader = { title: "Select Account", description: "Select an account to continue." }

// Lists the wallet's Lens accounts to sign in with, or the form to create one. Opens by itself when a
// wallet connects without a Lens session, and can't be dismissed until an account is signed in to (or
// the wallet disconnects). A dialog on desktop, a drawer on mobile. Render it inside <LensAuthProvider>.
export function AccountDialog() {
  const { signOut } = useLensAuth()
  const { open, required, setOpen } = useAccountDialog()
  const [{ title, description }, setHeader] = React.useState(DEFAULT_HEADER)
  const isDesktop = useMediaQuery("(min-width: 768px)")

  const handleOpenChange = (next: boolean) => {
    if (!next && required) return
    setOpen(next)
  }

  const leave = (
    // Without a Lens session there's only the wallet to disconnect; when switching accounts, it logs out too
    <Button onClick={signOut} variant="ghost" className="w-full">
      {required ? "Disconnect Wallet" : "Log Out"}
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
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <AccountPicker actions={leave} onHeaderChange={setHeader} />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} dismissible={!required}>
      <DrawerContent className="max-h-[80vh] overflow-y-auto">
        <DrawerHeader className="text-left">
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4">
          <AccountPicker actions={leave} onHeaderChange={setHeader} />
        </div>
      </DrawerContent>
    </Drawer>
  )
}

// The account dialog's content without the dialog: the account list, or the form to create one. Render it in
// your own dialog; `onHeaderChange` gives the title and description for what it shows. It has no horizontal
// padding. `actions` (e.g. a button to sign out) go in its button group, under "Create a new account" or the form's.
export function AccountPicker({ actions, onHeaderChange }: {
  actions?: React.ReactNode
  onHeaderChange?: (header: AccountPickerHeader) => void
}) {
  const { wallet } = useLensAuth()
  const { open } = useAccountDialog()
  const picker = useAccountPicker()
  const [creating, setCreating] = React.useState(false)

  // Show the account list again the next time the dialog opens, and for another wallet
  React.useEffect(() => {
    if (!open) setCreating(false)
  }, [open])
  React.useEffect(() => {
    setCreating(false)
  }, [wallet?.address])

  const loading = picker.status !== "ready"
  const hasAccounts = !loading && picker.accounts.length > 0
  // Wallets without an account go straight to creating one
  const showCreate = creating || (!loading && !hasAccounts)

  const title = showCreate ? "Create Account" : "Select Account"
  const description = showCreate
    ? hasAccounts ? "Pick a username for your new Lens account." : "You don’t have a Lens account yet. Create one to continue."
    : "Select an account to continue."

  // The dialog around the picker shows these, so they're set before it paints
  const reportHeader = React.useRef(onHeaderChange)
  React.useLayoutEffect(() => {
    reportHeader.current = onHeaderChange
  })
  React.useLayoutEffect(() => {
    reportHeader.current?.({ title, description })
  }, [title, description])

  if (picker.status === "no-wallet") return null

  if (showCreate) {
    return <CreateAccountForm onBack={hasAccounts ? () => setCreating(false) : undefined} actions={actions} />
  }

  if (loading) {
    return (
      <div className="py-4 space-y-3">
        <p className="text-sm text-muted-foreground">Loading available profiles…</p>
        {actions && <div className="flex flex-col gap-2">{actions}</div>}
      </div>
    )
  }

  return (
    <div className="py-4 space-y-3">
      <ul className="space-y-2 max-h-80 overflow-y-auto">
        {picker.accounts.map((account) => (
          <li key={account.id}>
            <button
              type="button"
              className="w-full text-left px-3 py-2 rounded-md border hover:bg-accent/50 flex items-center justify-between cursor-pointer disabled:cursor-default"
              onClick={() => picker.signIn(account)}
              disabled={picker.busy}
            >
              <span className="truncate">
                {account.username}
                {account.sharesUsername && (
                  <span className="text-muted-foreground"> · {account.address.slice(0, 6)}…{account.address.slice(-4)}</span>
                )}
              </span>
              {account.state === "signing-in" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {account.state === "tap-again" && <span className="text-sm font-medium text-primary">Sign in</span>}
            </button>
            {account.state === "tap-again" && (
              <p className="px-1 pt-1 text-xs text-muted-foreground">Tap again to sign the message in your wallet.</p>
            )}
            {account.state === "failed" && (
              <p className="px-1 pt-1 text-xs text-destructive">Couldn’t sign in. Please try again.</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <Button className="w-full" onClick={() => setCreating(true)} disabled={picker.busy}>
          Create a new account
        </Button>
        {actions}
      </div>
    </div>
  )
}
