import { PublicClient, evmAddress, signatureFrom, uri, type Account, type SessionClient } from "@lens-protocol/client"
import { canCreateUsername, createAccountWithUsername, fetchAccount, fetchUsername, fetchUsernames } from "@lens-protocol/client/actions"
import { handleOperationWith } from "@lens-protocol/client/viem"
import { account as accountMetadata } from "@lens-protocol/metadata"
import { StorageClient, immutable } from "@lens-chain/storage-client"
import { getTransactionReceipt } from "viem/actions"
import type { Wallet } from "thirdweb/wallets"
import type { LensAuth, LensChallenge } from "./auth"
import { sessionCredentials } from "./auth"
import { LENS_CHAIN_IDS } from "./constants"
import { createLensWalletClient } from "./wallet"

// An error whose message can be shown to the user as is.
export class OnboardingError extends Error {
  name = "OnboardingError"
}

// Creating an account takes a session as an onboarding user (a wallet signed in without a Lens Account).
// It runs on its own client, whose storage is in memory, so that session never reaches the app's token
// storage: until the account exists and is signed in to, the app must not treat the wallet as signed in.
export function createOnboardingClient(auth: LensAuth) {
  return PublicClient.create({ environment: auth.lensEnvironment })
}

export async function requestOnboardingChallenge(auth: LensAuth, client: PublicClient, walletAddress: string): Promise<LensChallenge> {
  const challenge = await client.challenge({
    onboardingUser: { app: evmAddress(auth.appAddress), wallet: evmAddress(walletAddress) },
  })
  if (challenge.isErr()) throw challenge.error
  return challenge.value
}

export async function authenticateOnboarding(client: PublicClient, challenge: LensChallenge, signature: string): Promise<SessionClient> {
  const authenticated = await client.authenticate({ id: challenge.id, signature: signatureFrom(signature) })
  if (authenticated.isErr()) throw authenticated.error
  return authenticated.value
}

// The global Lens namespace takes lowercase letters, numbers, "-" and "_", and can't start with "-" or "_".
// Its other rules (length, reserved names, price) are checked by the Lens API in checkUsername.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export function usernameFormatError(localName: string): string | null {
  if (!localName) return "Choose a username"
  if (/^[-_]/.test(localName)) return "Start with a letter or a number"
  if (!USERNAME_PATTERN.test(localName)) return "Use only lowercase letters, numbers, - and _"
  return null
}

// The username to create, in the app's namespace when it has one (else the global Lens namespace)
function usernameInput(auth: LensAuth, localName: string) {
  return auth.usernameNamespace ? { localName, namespace: evmAddress(auth.usernameNamespace) } : { localName }
}

// Needs no session, so it can run while the user types.
export async function isUsernameTaken(auth: LensAuth, localName: string): Promise<boolean> {
  const result = await fetchUsername(auth.lensClient, { username: usernameInput(auth, localName) })
  if (result.isErr()) throw result.error
  return result.value !== null
}

type NamespaceValidationFailed = {
  reason: string
  unsatisfiedRules: { required: { message: string }[] } | null
}

function validationFailedMessage(failed: NamespaceValidationFailed) {
  return failed.unsatisfiedRules?.required[0]?.message || failed.reason
}

// Returns why the username can't be created, or null if it can.
export async function checkUsername(auth: LensAuth, session: SessionClient, localName: string): Promise<string | null> {
  const result = await canCreateUsername(session, usernameInput(auth, localName))
  if (result.isErr()) throw result.error
  switch (result.value.__typename) {
    case "NamespaceOperationValidationPassed":
      return null
    case "UsernameTaken":
      return "This username is taken"
    case "NamespaceOperationValidationFailed":
      return validationFailedMessage(result.value)
    case "NamespaceOperationValidationUnknown":
      return "This username can’t be created here. Try another one."
  }
}

let storageClient: StorageClient | null = null

export type AccountProfile = {
  name?: string
  bio?: string
  picture?: File | null
}

// Uploads the account metadata (and its picture) to Grove, and returns the metadata URI.
export async function uploadAccountMetadata(auth: LensAuth, profile: AccountProfile): Promise<string> {
  storageClient ??= StorageClient.create()
  const acl = immutable(LENS_CHAIN_IDS[auth.environment])
  const picture = profile.picture ? (await storageClient.uploadFile(profile.picture, { acl })).uri : undefined
  const metadata = accountMetadata({
    name: profile.name || undefined,
    bio: profile.bio || undefined,
    picture,
  })
  const { uri: metadataUri } = await storageClient.uploadAsJson(metadata, { acl })
  return metadataUri
}

// How long to wait for a new account to be listed once its transaction is indexed
const ACCOUNT_POLL_ATTEMPTS = 15
const ACCOUNT_POLL_INTERVAL_MS = 2000

// Creates an account owned by the onboarding user's wallet. Most apps sponsor it; otherwise the wallet
// is asked to send the transaction.
export async function createLensAccount(
  auth: LensAuth,
  session: SessionClient,
  wallet: Wallet,
  request: { localName: string; metadataUri: string },
): Promise<Account> {
  const created = await createAccountWithUsername(session, {
    username: usernameInput(auth, request.localName),
    metadataUri: uri(request.metadataUri),
  })
  if (created.isErr()) throw created.error
  const result = created.value
  switch (result.__typename) {
    case "UsernameTaken":
      throw new OnboardingError("This username is taken")
    case "NamespaceOperationValidationFailed":
      throw new OnboardingError(validationFailedMessage(result))
    case "TransactionWillFail":
      throw new OnboardingError(result.reason)
  }

  const walletClient = createLensWalletClient({ wallet, client: auth.thirdwebClient, chain: auth.chain, viemChain: auth.viemChain })
  const sent = await handleOperationWith(walletClient)(result)
  if (sent.isErr()) throw sent.error
  const hash = sent.value

  const indexed = await session.waitForTransaction(hash)
  if (indexed.isErr()) {
    // The Lens API stops waiting for indexing after 10s on mainnet, so the receipt decides whether
    // the transaction failed. If it can't be read either, the account lookup below still settles it.
    const receipt = await getTransactionReceipt(walletClient, { hash }).catch(() => null)
    if (receipt?.status === "reverted") throw indexed.error
  }

  for (let attempt = 0; attempt < ACCOUNT_POLL_ATTEMPTS; attempt++) {
    const fetched = await fetchAccount(session, { txHash: hash })
    if (fetched.isOk() && fetched.value) return fetched.value
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_POLL_INTERVAL_MS))
  }
  throw new OnboardingError("Your account was created but isn’t ready yet. Sign in to it again in a minute.")
}

// An account's username in the namespace it prefers: the app's namespace, then the global Lens one, then
// any other. So accounts from apps with their own namespace can sign in too. Null if it has none.
export async function fetchAccountUsername(auth: LensAuth, accountAddress: string): Promise<string | null> {
  const result = await fetchUsernames(auth.lensClient, { filter: { linkedTo: evmAddress(accountAddress) } })
  if (result.isErr()) throw result.error
  const preferred = auth.usernameNamespace?.toLowerCase()
  const rank = (username: { namespace: string; value: string }) =>
    username.namespace.toLowerCase() === preferred ? 0 : username.value.startsWith("lens/") ? 1 : 2
  const [best] = [...result.value.items].sort((a, b) => rank(a) - rank(b))
  return best?.localName ?? null
}

// Signs the app in to the new account without another signature: the onboarding session switches to it,
// and its tokens are handed to the app's Lens client, like a sign-in from the account list.
export async function signInToCreatedAccount(auth: LensAuth, session: SessionClient, accountAddress: string): Promise<void> {
  const switched = await session.switchAccount({ account: evmAddress(accountAddress) })
  if (switched.isErr()) throw switched.error
  auth.tokens.storeCredentials(sessionCredentials(switched.value))
  const resumed = await auth.lensClient.resumeSession()
  if (resumed.isErr()) throw resumed.error
}
