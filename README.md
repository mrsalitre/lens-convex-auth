# lens-convex-auth

Drop-in sign-in for [Lens](https://lens.xyz) apps: a **thirdweb** wallet, **Lens account** sign-in and
creation, and **Convex** auth, wired to one session.

- Headless by default: a provider and hooks for the session, the account list and creating an account,
  for a UI of your own
- Optional styled components (`lens-convex-auth/react/ui`): a `Sign in` button that connects any wallet
  thirdweb supports (injected, WalletConnect, email, passkeys, …), and an account dialog that lists the
  wallet's Lens accounts or creates one (username, name, bio, picture)
- Works on mobile wallets: challenges are fetched ahead of time, so the tap that signs can open the wallet app
- Lens tokens are kept fresh in the background and shared by the Lens SDK, Convex, and your API routes
- Switching accounts and logging out revoke the Lens session, so tokens copied from the browser stop working
- Convex functions know which Lens account is calling (`requireLensAccount(ctx)`)

```
wallet (thirdweb) ──▶ Lens challenge ──▶ signature ──▶ Lens tokens (localStorage, auto-refreshed)
                                                            │
                               POST /api/convex-token ◀─────┘  Lens ID token (verified against Lens JWKS)
                                        │
                                        ▼
                     short-lived RS256 token, subject = Lens account ──▶ Convex (customJwt provider)
```

Convex can't verify Lens ID tokens directly (Lens signs them without a `kid` header), so your server
verifies the Lens ID token and issues a short-lived token that Convex trusts.

## Install

```bash
pnpm add lens-convex-auth thirdweb convex viem @lens-protocol/client @lens-protocol/react @lens-protocol/metadata @lens-chain/storage-client
```

Requires React 19. That's all the headless API (`lens-convex-auth/react`) needs.

To use the styled components (`lens-convex-auth/react/ui`), add their dependencies too. They're optional
peer dependencies, so apps that draw their own UI don't install them:

```bash
pnpm add @radix-ui/react-avatar @radix-ui/react-dialog @radix-ui/react-label @radix-ui/react-slot vaul lucide-react class-variance-authority clsx tailwind-merge
```

They're styled with Tailwind CSS v4 and [shadcn/ui](https://ui.shadcn.com) theme variables, so they follow
your app's theme.

## Setup (Next.js)

### 1. Environment

```bash
# .env.local
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=     # https://thirdweb.com/dashboard
NEXT_PUBLIC_LENS_APP_ADDRESS=       # https://developer.lens.xyz/apps
NEXT_PUBLIC_CONVEX_URL=             # written by `npx convex dev`
CONVEX_AUTH_PRIVATE_KEY=            # step 2
```

### 2. Keys for Convex tokens

```bash
npx lens-convex-auth keys
```

It prints two values:

- `CONVEX_AUTH_PRIVATE_KEY`: add it to `.env.local` (and your host's env, e.g. Vercel). Keep it secret.
- `CONVEX_AUTH_JWKS`: set it on your Convex deployment (quote the value):

  ```bash
  npx convex env set CONVEX_AUTH_JWKS 'data:text/plain;charset=utf-8;base64,...'
  ```

Generate one pair per environment (dev, prod), and never copy a private key between them.

### 3. Create the auth instance

```ts
// lib/auth.ts
import { createLensAuth } from "lens-convex-auth"

export const auth = createLensAuth({
  thirdwebClientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID!,
  lensAppAddress: process.env.NEXT_PUBLIC_LENS_APP_ADDRESS!,
  // environment: "testnet",
})
```

### 4. Add the provider

```tsx
// app/providers.tsx
"use client"

import { ConvexReactClient } from "convex/react"
import { LensAuthProvider } from "lens-convex-auth/react"
import { AccountDialog } from "lens-convex-auth/react/ui"
import { auth } from "@/lib/auth"

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LensAuthProvider auth={auth} convex={convex}>
      {children}
      <AccountDialog />
    </LensAuthProvider>
  )
}
```

```tsx
// app/layout.tsx
import { Providers } from "./providers"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

`LensAuthProvider` includes `ThirdwebProvider`, `LensProvider` and `ConvexProviderWithAuth`, so don't add
them again. Lens React hooks and Convex hooks work anywhere inside it.

The provider renders no UI. `<AccountDialog />` is the styled dialog that picks or creates the Lens account
after a wallet connects; for your own, see [Your own account dialog](#your-own-account-dialog).

### 5. Add the token route

```ts
// app/api/convex-token/route.ts
import { createConvexTokenHandler } from "lens-convex-auth/server"

export const POST = createConvexTokenHandler({
  lensAppAddress: process.env.NEXT_PUBLIC_LENS_APP_ADDRESS!,
})
```

### 6. Trust it in Convex

```ts
// convex/auth.config.ts
import { lensAuthProvider } from "lens-convex-auth/convex"

export default {
  providers: [lensAuthProvider({ jwks: process.env.CONVEX_AUTH_JWKS })],
}
```

### 7. Let Tailwind see the components (styled UI only)

```css
/* app/globals.css */
@import "tailwindcss";
@import "tw-animate-css"; /* optional: dialog animations */
@source "../node_modules/lens-convex-auth/dist";
```

The path is relative to the CSS file. The components use the shadcn variables (`--background`,
`--primary`, `--muted-foreground`, …), which `npx shadcn init` adds.

### 8. Use it

```tsx
import { SignInButton } from "lens-convex-auth/react/ui"

export function Navbar() {
  return (
    <nav className="flex justify-between">
      <span>My app</span>
      <SignInButton />
    </nav>
  )
}
```

Connecting a wallet opens the account dialog, which stays open until the user signs in to an account
(or disconnects). The button then becomes `Logout`. Switching to another account from the dialog
revokes the previous account's session (see [Security](#security)).

In Convex functions:

```ts
// convex/posts.ts
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import { getLensAccount, requireLensAccount } from "lens-convex-auth/convex"

export const create = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const account = await requireLensAccount(ctx) // throws when signed out
    await ctx.db.insert("posts", { account, text })
  },
})

export const mine = query({
  handler: async (ctx) => {
    const account = await getLensAccount(ctx) // null when signed out
    if (!account) return []
    return ctx.db.query("posts").withIndex("by_account", (q) => q.eq("account", account)).collect()
  },
})
```

In components:

```tsx
"use client"
import { useLensAuth } from "lens-convex-auth/react"

export function Me() {
  const { status, account, wallet, signOut, openAccountDialog } = useLensAuth()
  if (status !== "signed-in") return null
  return <button onClick={openAccountDialog}>@{account?.username ?? account?.address}</button>
}
```

## Recipes

### Create a user row on sign-in

`onSignIn` runs after the user signs in from the dialog, once Convex has accepted the session, so it can
call authenticated functions:

```tsx
<LensAuthProvider
  auth={auth}
  convex={convex}
  onSignIn={() => convex.mutation(api.users.ensureCurrentUser, {})}
>
```

```ts
// convex/users.ts
export const ensureCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const account = await requireLensAccount(ctx)
    const existing = await ctx.db.query("users").withIndex("by_account", (q) => q.eq("account", account)).unique()
    return existing?._id ?? (await ctx.db.insert("users", { account, createdAt: Date.now() }))
  },
})
```

### Delete your app's data when the account changes

If your app keeps anything in the browser for the signed-in account (drafts, caches, keys in IndexedDB),
delete it in `onAccountChange`. It runs when the signed-in account changes, however that happens:
signing in, switching accounts, logging out, or the session ending (it expired, or another tab logged
out). It doesn't run when a stored session is restored on load.

```tsx
<LensAuthProvider
  auth={auth}
  convex={convex}
  onAccountChange={async (previous, next) => {
    if (previous) await deleteLocalData(previous.address)
  }}
>
```

It runs after the change, so it can't call Convex as `previous`. To do something as the account before it
logs out, do it before calling `signOut()`.

### Protect your own API routes

On the client, `auth.fetch` sends the Lens ID token and retries once with a refreshed token on 401:

```ts
const res = await auth.fetch("/api/me")
```

On the server, `getLensSession` verifies it:

```ts
// app/api/me/route.ts
import { getLensSession } from "lens-convex-auth/server"

export async function GET(request: Request) {
  const session = await getLensSession(request, { lensAppAddress: process.env.NEXT_PUBLIC_LENS_APP_ADDRESS! })
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 })
  return Response.json({ account: session.account })
}
```

### Call Convex from the server as the user

```ts
import { fetchMutation } from "convex/nextjs"
import { createConvexToken, getLensSession } from "lens-convex-auth/server"

const session = await getLensSession(request, { lensAppAddress })
if (session) await fetchMutation(api.users.ensureCurrentUser, {}, { token: await createConvexToken(session) })
```

### Your own account dialog

Leave out `<AccountDialog />` and build the dialog from the hooks. `useAccountDialog()` says when to show
it, `useAccountPicker()` lists the wallet's accounts and signs in to one, and `useCreateAccount()` is the
state of a form that creates one:

```tsx
"use client"
import { useAccountDialog, useAccountPicker, useCreateAccount, useLensAuth } from "lens-convex-auth/react"

function MyAccountDialog() {
  const { signOut } = useLensAuth()
  const { open, required, setOpen } = useAccountDialog()
  const picker = useAccountPicker()
  const [creating, setCreating] = React.useState(false)
  const noAccounts = picker.status === "ready" && picker.accounts.length === 0

  return (
    <MyDialog open={open} onOpenChange={setOpen} dismissible={!required}>
      {creating || noAccounts ? (
        <MyCreateAccountForm />
      ) : (
        <ul>
          {picker.accounts.map((account) => (
            <li key={account.id}>
              {/* Call signIn straight from the click: on mobile that tap is what opens the wallet app */}
              <button onClick={() => picker.signIn(account)} disabled={picker.busy}>
                @{account.username}
                {account.state === "signing-in" && <Spinner />}
              </button>
              {account.state === "tap-again" && <p>Tap again to sign in your wallet.</p>}
              {account.state === "failed" && <p>Couldn’t sign in. Try again.</p>}
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => setCreating(true)}>Create an account</button>
      <button onClick={signOut}>{required ? "Disconnect wallet" : "Log out"}</button>
    </MyDialog>
  )
}

function MyCreateAccountForm() {
  const form = useCreateAccount()
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.submit() }}>
      <input value={form.username} onChange={(e) => form.setUsername(e.target.value)} disabled={form.busy} />
      {"message" in form.usernameStatus && <p>{form.usernameStatus.message}</p>}
      {/* Name, bio and picture are optional: leave out the ones you don't ask for */}
      <button type="submit" disabled={form.busy}>{form.step ? "Creating…" : "Create account"}</button>
      {form.error && <p>{form.error}</p>}
    </form>
  )
}
```

`required` is true while a wallet is connected without a Lens account signed in: the dialog shouldn't close
then (`setOpen(false)` is ignored), so give it a way out, like the log out button above. Signing in, or
creating an account, closes the dialog and calls `onSignIn`.

To keep the styled list and form but put them in your own dialog, render `<AccountPicker />` from
`lens-convex-auth/react/ui` inside it. `onHeaderChange` gives the title and description for what it shows,
and buttons passed as `actions` go in its button group. The lower-level building blocks
(`auth.requestChallenge`, `auth.authenticate`, `createLensAccount`, `uploadAccountMetadata`, …) are in the
main entry.

### Without Convex

Omit the `convex` prop. Everything else works the same.

## API

### `createLensAuth(options)` (`lens-convex-auth`)

| Option | Default | |
| --- | --- | --- |
| `thirdwebClientId` | required | thirdweb client ID |
| `lensAppAddress` | required | Your Lens app. Tokens are issued for it. |
| `environment` | `"mainnet"` | `"mainnet"` or `"testnet"` |
| `lensChainRpcUrl` | thirdweb's RPC | Lens Chain RPC URL for thirdweb |
| `storagePrefix` | `"lens_"` | Prefix of the localStorage keys the session is stored under |
| `convexTokenEndpoint` | `"/api/convex-token"` | Where the token route lives |
| `usernameNamespace` | global Lens namespace | Namespace (0x…) new accounts get their username in. The account list shows usernames from it first, then the global one, then any other |

Returns `auth` with `thirdwebClient`, `chain`, `lensClient`, `tokens`, `getSession()`,
`resumeSession()`, `requestChallenge()`, `authenticate()`, `startSession()`, `logout()`, `fetch()` and
`fetchConvexToken()`.

- `authenticate(challenge, signature)` and `startSession(credentials)` make a session the app's, and revoke
  the session they replace. `startSession` resolves `false` when that revocation failed.
- `logout()` clears the session from the browser, then revokes it. Resolves `{ revoked }`, false when the
  Lens API couldn't be reached or refused.

### `<LensAuthProvider>` (`lens-convex-auth/react`)

Renders no UI: add `<AccountDialog />`, or [your own](#your-own-account-dialog).


| Prop | |
| --- | --- |
| `auth` | From `createLensAuth` |
| `convex` | Your `ConvexReactClient` (optional) |
| `onSignIn(account)` | Called after a sign-in from the dialog, once Convex accepts it |
| `onAccountChange(previous, next)` | Called when the signed-in account changes: sign-in, switch, log out, or the session ending. See the recipe above |
| `wallets` | Wallets to reconnect after a reload while a Lens session is stored (default: thirdweb's). Pass the same list as `SignInButton`'s `connectButtonProps.wallets` if you customize it |

### `useLensAuth()`

`{ status, isLoading, isSignedIn, wallet, account, signOut, openAccountDialog, auth }`

`signOut()` disconnects the wallet and logs out, revoking the session. It resolves `{ revoked }`, false
when revoking failed (the session is cleared from the browser either way), so you can tell the user.

`status` is `"loading"` (first render and SSR), `"signed-out"`, `"choosing-account"` (wallet connected,
no Lens account yet) or `"signed-in"`. `account` is `{ address, username }`.

### `useAccountDialog()`

`{ open, required, setOpen }`: whether to show the account dialog. It opens by itself when a wallet connects
without a Lens session (and is `required` until one is signed in), and with `openAccountDialog()`.

### `useAccountPicker()`

`{ status, accounts, busy, signIn }`. `status` is `"no-wallet"`, `"loading"` or `"ready"`. Each account is
`{ id, address, username, isOwner, sharesUsername, state }`; `sharesUsername` means another listed account
has the same username, so show its address too. `state` is `"idle"`, `"signing-in"`, `"tap-again"` (call
`signIn` again: on mobile it takes a second tap to open the wallet) or `"failed"`. Accounts without a
username aren't listed.

### `useCreateAccount()`

`{ username, setUsername, usernameStatus, name, setName, bio, setBio, picture, pictureUrl, setPicture, step,
busy, error, submit }`. `usernameStatus.status` is `"empty"`, `"checking"`, `"available"`, `"unknown"`,
`"invalid"`, `"taken"` or `"rejected"`, the last three with a `message`. `step` is `"signing"`,
`"tap-again"`, `"checking"`, `"uploading"`, `"creating"` or `"signing-in"`. Call `submit()` from the
submit handler; a retry after a failure doesn't sign again or create a second account.

### `<SignInButton>`, `<AccountDialog>`, `<AccountPicker>`, `<CreateAccountForm>` (`lens-convex-auth/react/ui`)

The styled components, built on the hooks above. `<SignInButton>` takes:

| Prop | Default | |
| --- | --- | --- |
| `label` | `"Sign in"` | |
| `signOutLabel` | `"Logout"` | |
| `theme` | page theme | thirdweb modal theme: a `dark`/`light` class on `<html>`, else the system's |
| `className` | | For the loading and logout buttons |
| `connectButtonProps` | | Passed to thirdweb's `ConnectButton` (`wallets`, `connectModal`, …) |

thirdweb's `ConnectButton` (~480KB gzipped of wallet SDKs) is loaded on demand, so it stays out of
your pages' initial bundle.

### Server (`lens-convex-auth/server`)

- `createConvexTokenHandler(options)`: `POST` handler using the standard `Request`/`Response`
- `getLensSession(request, options)`: `{ account, expiresAt } | null` from `Authorization: Bearer`
- `verifyLensIdToken(idToken, options)`: the same, from a token
- `createConvexToken(session, options?)`: a Convex token for the account

Options: `lensAppAddress` (required), `environment`, and for Convex tokens `privateKey` (default
`process.env.CONVEX_AUTH_PRIVATE_KEY`), `issuer`, `audience`, `keyId`. If you change `issuer` or
`audience`, pass the same values to `lensAuthProvider`.

### Convex (`lens-convex-auth/convex`)

- `lensAuthProvider({ jwks, issuer?, audience? })`: provider for `convex/auth.config.ts`
- `getLensAccount(ctx)`: the caller's Lens account (lowercased) or `null`
- `requireLensAccount(ctx, message?)`: the same, or throws a `ConvexError`

### CLI

- `npx lens-convex-auth keys [--kid <id>]`: generates a key pair for Convex tokens

## Security

What the browser holds while someone is signed in, and what ends it:

| Stored | Where | What it allows | Ended by |
| --- | --- | --- | --- |
| Lens access, ID and refresh tokens | `localStorage` (`lens_access_token`, `lens_id_token`, `lens_refresh_token`) | Acting as the Lens account through the Lens API, and getting Convex tokens from your token route | Switching accounts or logging out: the session is revoked on the Lens API |
| Selected account | `localStorage` (`lens_account`) | Nothing: its address and username | Logging out |
| Convex token | Memory | Calling Convex as the account | Expires with the Lens ID token |
| thirdweb wallet session | thirdweb's own storage | Email, social and passkey wallets: signing as the wallet, which owns its Lens accounts. Extension and mobile wallets keep their keys to themselves | Logging out disconnects the wallet. thirdweb clears its session from the browser; it doesn't revoke it on its servers |

Revoking stops the refresh token right away. An access or ID token already issued stays valid until it
expires, 10 minutes at most, because your server and Convex verify tokens by signature without asking
Lens. A copied session is cut off within those 10 minutes.

`localStorage` is readable by any script running on your pages, so a cross-site scripting bug, or a
script you load from a compromised source, can copy these tokens. Revocation limits how long a copy
works; it doesn't prevent the copy. Keep scripts off your pages with a Content Security Policy, and load
third-party scripts only from sources you trust.

If revoking fails (offline, or the Lens API is down), the session is still cleared from the browser,
`signOut()` resolves `{ revoked: false }`, and the refresh token works until Lens expires it.

## Troubleshooting

**Turbopack fails to resolve `@x402/*` packages.** Recent `@coinbase/cdp-sdk` versions (a
thirdweb dependency) import optional packages Turbopack can't resolve. Pin it in your
`pnpm-workspace.yaml` (or `overrides` in `package.json`):

```yaml
overrides:
  '@coinbase/cdp-sdk': 1.52.0
```

**Convex says the user isn't authenticated.** Check that `CONVEX_AUTH_JWKS` on the deployment and
`CONVEX_AUTH_PRIVATE_KEY` on the server come from the same `keys` run, and that `issuer`/`audience` match
on both sides if you changed them.

**The dialog is unstyled.** Tailwind isn't scanning the package: add the `@source` line from step 7.

## Upgrading from 0.4

- The provider no longer renders the account dialog, and its `accountDialog` prop is gone. Add
  `<AccountDialog />` inside `<LensAuthProvider>`, or build your own from the hooks.
- `SignInButton`, `AccountDialog`, `AccountPicker` and `CreateAccountForm` moved to
  `lens-convex-auth/react/ui`, and their dependencies (Radix, vaul, lucide-react, …) are optional peer
  dependencies now: install them to keep using the components (see [Install](#install)).
- `useAccountDialog()` no longer returns `title` and `description`. `<AccountPicker>` gives them through
  `onHeaderChange`.
- `CreateAccountForm` no longer takes `ownerAddress` or `onCreated`: it uses the connected wallet, and
  `onSignIn` on the provider runs after the account is created.

## License

MIT
