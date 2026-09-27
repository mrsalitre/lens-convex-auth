import { execFileSync } from "node:child_process"
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from "jose"
import { beforeAll, describe, expect, it } from "vitest"
import { createConvexToken, createConvexTokenHandler, getLensSession, verifyLensIdToken } from "../src/server"
import { getLensAccount, lensAuthProvider, requireLensAccount } from "../src/convex"

const APP = "0x8A5Cc31180c37078e1EbA2A23c861Acf351a97cE"
const ACCOUNT = "0x1111111111111111111111111111111111111111"
const WALLET = "0x2222222222222222222222222222222222222222"

// Stands in for Lens: signs ID tokens with a local key, published as a local JWKS
let lensKey: CryptoKey
let lensJwks: ReturnType<typeof createLocalJWKSet>

async function lensIdToken(claims: Record<string, unknown> = {}, issuer = "https://api.lens.xyz") {
  return new SignJWT({ act: { sub: ACCOUNT }, sid: "session-1", aud: APP, ...claims })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer)
    .setSubject(WALLET)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(lensKey)
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256")
  lensKey = privateKey
  lensJwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256" }] })
})

describe("verifyLensIdToken", () => {
  it("returns the account an ID token for this app acts for", async () => {
    const session = await verifyLensIdToken(await lensIdToken(), { lensAppAddress: APP, jwks: lensJwks })
    expect(session?.account).toBe(ACCOUNT)
    expect(session?.expiresAt).toBeGreaterThan(Date.now() / 1000)
  })

  it("matches the app address case-insensitively", async () => {
    const session = await verifyLensIdToken(await lensIdToken(), { lensAppAddress: APP.toLowerCase(), jwks: lensJwks })
    expect(session?.account).toBe(ACCOUNT)
  })

  it("rejects tokens issued to another app", async () => {
    const token = await lensIdToken({ aud: "0x3333333333333333333333333333333333333333" })
    expect(await verifyLensIdToken(token, { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
  })

  it("rejects onboarding sessions (no account)", async () => {
    const token = await lensIdToken({ act: undefined })
    expect(await verifyLensIdToken(token, { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
  })

  it("rejects tokens from the other Lens environment", async () => {
    const testnetToken = await lensIdToken({}, "https://api.testnet.lens.xyz")
    expect(await verifyLensIdToken(testnetToken, { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
    const session = await verifyLensIdToken(testnetToken, { lensAppAddress: APP, environment: "testnet", jwks: lensJwks })
    expect(session?.account).toBe(ACCOUNT)
  })

  it("rejects tokens signed by someone else", async () => {
    const { privateKey } = await generateKeyPair("ES256")
    const forged = await new SignJWT({ act: { sub: ACCOUNT } })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("https://api.lens.xyz")
      .setAudience(APP)
      .setExpirationTime("10m")
      .sign(privateKey)
    expect(await verifyLensIdToken(forged, { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
  })

  it("rejects garbage", async () => {
    expect(await verifyLensIdToken("not-a-jwt", { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
  })

  it("throws when the app address isn't configured", async () => {
    await expect(verifyLensIdToken(await lensIdToken(), { lensAppAddress: "", jwks: lensJwks })).rejects.toThrow(/lensAppAddress/)
  })
})

describe("Convex tokens", () => {
  let privateKey: string
  let convexJwks: JSONWebKeySet

  beforeAll(async () => {
    // Keys as `npx lens-convex-auth keys` prints them
    const output = execFileSync("node", ["--import", "tsx", "src/cli/index.ts", "keys"], { encoding: "utf8" }).trim()
    const [pemLine, jwksLine] = output.split("\n")
    privateKey = JSON.parse(pemLine.slice("CONVEX_AUTH_PRIVATE_KEY=".length))
    const dataUrl = jwksLine.slice("CONVEX_AUTH_JWKS=".length)
    convexJwks = JSON.parse(Buffer.from(dataUrl.split(",")[1], "base64").toString())
    expect(lensAuthProvider({ jwks: dataUrl }).jwks).toBe(dataUrl)
  })

  // Checks a token the way Convex does with lensAuthProvider()
  async function verifyAsConvex(token: string) {
    const provider = lensAuthProvider({ jwks: "unused" })
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(convexJwks), {
      issuer: provider.issuer,
      audience: provider.applicationID,
      algorithms: [provider.algorithm],
    })
    return { payload, protectedHeader }
  }

  it("issues a token Convex accepts, for the Lens account, expiring with the Lens session", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const token = await createConvexToken({ account: ACCOUNT, expiresAt }, { privateKey })
    const { payload, protectedHeader } = await verifyAsConvex(token)
    expect(payload.sub).toBe(ACCOUNT)
    expect(payload.exp).toBe(expiresAt)
    expect(protectedHeader.kid).toBe(convexJwks.keys[0].kid)
  })

  it("accepts the private key with escaped newlines, as env files store it", async () => {
    const escaped = privateKey.replace(/\n/g, "\\n")
    const token = await createConvexToken({ account: ACCOUNT, expiresAt: Math.floor(Date.now() / 1000) + 600 }, { privateKey: escaped })
    expect((await verifyAsConvex(token)).payload.sub).toBe(ACCOUNT)
  })

  it("exchanges a Lens ID token through the route handler", async () => {
    const POST = createConvexTokenHandler({ lensAppAddress: APP, jwks: lensJwks, privateKey })
    const ok = await POST(new Request("http://localhost/api/convex-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${await lensIdToken()}` },
    }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    const { token } = await ok.json()
    expect((await verifyAsConvex(token)).payload.sub).toBe(ACCOUNT)

    const missing = await POST(new Request("http://localhost/api/convex-token", { method: "POST" }))
    expect(missing.status).toBe(401)
    const wrongApp = await POST(new Request("http://localhost/api/convex-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${await lensIdToken({ aud: WALLET })}` },
    }))
    expect(wrongApp.status).toBe(401)
  })

  it("reads the session of a request sent with auth.fetch", async () => {
    const request = new Request("http://localhost/api/me", { headers: { Authorization: `Bearer ${await lensIdToken()}` } })
    expect((await getLensSession(request, { lensAppAddress: APP, jwks: lensJwks }))?.account).toBe(ACCOUNT)
    expect(await getLensSession(new Request("http://localhost/api/me"), { lensAppAddress: APP, jwks: lensJwks })).toBeNull()
  })
})

describe("Convex helpers", () => {
  const ctx = (subject?: string) => ({
    auth: { getUserIdentity: async () => (subject ? { subject, issuer: "x", tokenIdentifier: `x|${subject}` } : null) },
  }) as unknown as Parameters<typeof getLensAccount>[0]

  it("reads the Lens account from the identity", async () => {
    expect(await getLensAccount(ctx(ACCOUNT.toUpperCase().replace("0X", "0x")))).toBe(ACCOUNT)
    expect(await getLensAccount(ctx())).toBeNull()
    expect(await getLensAccount(ctx("user_123"))).toBeNull()
  })

  it("requireLensAccount throws when signed out", async () => {
    await expect(requireLensAccount(ctx())).rejects.toThrow("Sign in with Lens to continue")
    expect(await requireLensAccount(ctx(ACCOUNT))).toBe(ACCOUNT)
  })
})
