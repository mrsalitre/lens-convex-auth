import * as React from "react"
import type { ConnectButtonProps } from "thirdweb/react"
import { useLensAuth } from "./provider"
import { useDocumentTheme } from "./dom"
import { Button } from "./ui/button"
import { cn } from "./utils"

// thirdweb's ConnectButton pulls in ~480KB (gzipped) of wallet SDKs (WalletConnect, Coinbase, ...).
// Loading it on demand keeps that out of every page's initial bundle, so pages hydrate without
// waiting for it.
const ConnectButton = React.lazy(() => import("thirdweb/react").then((m) => ({ default: m.ConnectButton })))

export type SignInButtonProps = {
  /** Defaults to "Sign in" */
  label?: React.ReactNode
  /** Defaults to "Logout" */
  signOutLabel?: React.ReactNode
  /** thirdweb modal theme. Defaults to the page's theme (a `dark` class on <html>, or the system's). */
  theme?: "light" | "dark"
  /** Classes for the placeholder and sign-out buttons. Size the button's wrapper to size them all alike. */
  className?: string
  /** Extra props for thirdweb's ConnectButton (wallets, connectModal, ...) */
  connectButtonProps?: Partial<Omit<ConnectButtonProps, "client" | "chain" | "theme">>
}

// Connects a wallet (the account dialog then opens to pick or create a Lens account) and signs out.
export function SignInButton({ label = "Sign in", signOutLabel = "Logout", theme, className, connectButtonProps }: SignInButtonProps) {
  const { auth, wallet, status, signOut } = useLensAuth()
  const documentTheme = useDocumentTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  // Same size as the real button, so nothing shifts when it loads
  const placeholder = (
    <Button variant="outline" size="xl" className={cn("min-w-[165px] px-0", className)} disabled>
      Loading...
    </Button>
  )

  // thirdweb's ConnectButton doesn't render the same on the server and the client
  if (!mounted) return placeholder

  if (!wallet) {
    return (
      <React.Suspense fallback={placeholder}>
        <ConnectButton
          client={auth.thirdwebClient}
          chain={auth.chain}
          theme={theme ?? documentTheme}
          {...connectButtonProps}
          connectButton={{
            label,
            ...connectButtonProps?.connectButton,
            style: { height: "50px", minWidth: "165px", ...connectButtonProps?.connectButton?.style },
          }}
        />
      </React.Suspense>
    )
  }

  if (status !== "signed-in") return placeholder

  return (
    <Button variant="ghost" size="xl" className={cn("min-w-[165px] px-0", className)} onClick={signOut}>
      {signOutLabel}
    </Button>
  )
}
