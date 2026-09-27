// Claims of a JWT, without verifying it (the server verifies). Null if it isn't a JWT.
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    const claims = JSON.parse(json)
    return claims && typeof claims === "object" ? claims : null
  } catch {
    return null
  }
}

// When a JWT expires (ms since epoch), from its `exp` claim
export function jwtExpiresAt(token: string): number | null {
  const exp = Number(decodeJwtPayload(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
}

// The Lens account a Lens ID token acts for (`act.sub`), lowercased, and the session it belongs to.
// Null for tokens without an account (onboarding users) or that aren't JWTs.
export function lensSessionFromIdToken(idToken: string): { account: string; sessionId: string } | null {
  const claims = decodeJwtPayload(idToken)
  const act = claims?.act as { sub?: unknown } | null | undefined
  if (typeof act?.sub !== "string") return null
  return { account: act.sub.toLowerCase(), sessionId: String(claims?.sid ?? "") }
}
