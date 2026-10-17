// What <LensAuthProvider orb={…}> needs from createOrbAuth() (lens-convex-auth/orb). Kept free of Orb SDK
// imports, so the React entry and its type declarations work in apps that don't install @orbclub/apps-sdk.

export type OrbSessionStatus =
  /** Waiting for Orb's context, or signing the viewer back in without UI */
  | "loading"
  | "signed-out"
  /** Orb's approval sheet is open */
  | "signing-in"
  | "signed-in"

export type OrbSessionState = {
  status: OrbSessionStatus
  /** The Orb profile's Lens account (address lowercased) and its username, when Orb sent one */
  account: { address: string; username: string | null } | null
  /** Changes with each new sign-in, not when the same session is renewed */
  sessionId: number
  /** Why the last sign-in failed or the session ended, for showing to the viewer */
  error: string | null
}

export type OrbAuthSource = {
  /** True when the page runs inside Orb (or the Orb sandbox). Always false on the server. */
  isInsideOrb(): boolean
  subscribe(listener: () => void): () => void
  getState(): OrbSessionState
  /** Starts following Orb's context and restores the session; returns the function that stops it */
  start(): () => void
  /** Opens Orb's approval sheet. Resolves once signed in, or with the reason in `state.error`. */
  signIn(): Promise<void>
  signOut(): Promise<void>
  fetchConvexToken(forceRefresh: boolean): Promise<string | null>
}
