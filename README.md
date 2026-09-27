# lens-convex-auth

Drop-in sign-in for [Lens](https://lens.xyz) apps: a **thirdweb** wallet, **Lens account** sign-in and
creation, and **Convex** auth, wired to one session.

- A `Sign in` button that connects any wallet thirdweb supports (injected, WalletConnect, email, passkeys, …)
- An account dialog that lists the wallet's Lens accounts, or creates one (username, name, bio, picture)
- Works on mobile wallets: challenges are fetched ahead of time, so the tap that signs can open the wallet app
- Lens tokens are kept fresh in the background and shared by the Lens SDK, Convex, and your API routes
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

Requires React 19. The components are styled with Tailwind CSS v4 and
[shadcn/ui](https://ui.shadcn.com) theme variables, so they follow your app's theme.

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
import { auth } from "@/lib/auth"

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LensAuthProvider auth={auth} convex={convex}>
      {children}
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

### 7. Let Tailwind see the components

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
import { SignInButton } from "lens-convex-auth/react"

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
(or disconnects). The button then becomes `Logout`.

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

### Your own dialog placement or UI

Pass `accountDialog={false}` and render `<AccountDialog />` where you want it. `CreateAccountForm` is
exported too, and the lower-level building blocks (`auth.requestChallenge`, `auth.authenticate`,
`createLensAccount`, `uploadAccountMetadata`, …) are in the main entry.

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

Returns `auth` with `thirdwebClient`, `chain`, `lensClient`, `tokens`, `getSession()`,
`resumeSession()`, `requestChallenge()`, `authenticate()`, `logout()`, `fetch()` and `fetchConvexToken()`.

### `<LensAuthProvider>` (`lens-convex-auth/react`)

| Prop | |
| --- | --- |
| `auth` | From `createLensAuth` |
| `convex` | Your `ConvexReactClient` (optional) |
| `onSignIn(account)` | Called after a sign-in from the dialog, once Convex accepts it |
| `accountDialog` | Render the account dialog (default `true`) |

### `useLensAuth()`

`{ status, isLoading, isSignedIn, wallet, account, signOut, openAccountDialog, auth }`

`status` is `"loading"` (first render and SSR), `"signed-out"`, `"choosing-account"` (wallet connected,
no Lens account yet) or `"signed-in"`. `account` is `{ address, username }`.

### `<SignInButton>`

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

## License

MIT
