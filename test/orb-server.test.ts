import { execFileSync } from "node:child_process"
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose"
import { ORB_LENS_APP_ADDRESS, ORB_SANDBOX_REQUESTOR_DOMAIN } from "@orbclub/apps-sdk"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { lensAuthProvider } from "../src/convex"
import { createOrbConvexTokenHandler, getOrbSession, verifyOrbSession } from "../src/orb/server"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const OTHER_APP = "0x4444444444444444444444444444444444444444"

// Shaped like a JWT, which is all the server checks before asking Orb
function orbToken(claims: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "ES256" })}.${encode({ act: { sub: ACCOUNT }, exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.${encode("signature")}`
}

// Stands in for Orb's API: answers get-auth-context with this session, or with `answer` itself
function orbAnswers(answer: Record<string, unknown> | Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    expect(url).toContain("get-auth-context")
    if (answer instanceof Response) return answer
    return Response.json({ status: "SUCCESS", data: answer })
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

const inOrb = (overrides: Record<string, unknown> = {}) => ({
  accountAddress: ACCOUNT,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  applicationId: ORB_LENS_APP_ADDRESS,
  requestorDomain: null,
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("verifyOrbSession", () => {
  it("returns the account of a token Orb issued inside Orb, expiring with it", async () => {
    const session = inOrb()
    orbAnswers(session)
    expect(await verifyOrbSession(orbToken())).toEqual({
      account: ACCOUNT,
      expiresAt: Math.floor(Date.parse(session.expiresAt) / 1000),
    })
  })

  it("refuses in-Orb tokens with acceptOrbApp: false", async () => {
    orbAnswers(inOrb())
    expect(await verifyOrbSession(orbToken(), { acceptOrbApp: false })).toBeNull()
  })

  it("refuses tokens issued to another Lens app with no site", async () => {
    orbAnswers(inOrb({ applicationId: OTHER_APP }))
    expect(await verifyOrbSession(orbToken())).toBeNull()
  })

  it("accepts the sandbox's tokens only when allowed", async () => {
    orbAnswers(inOrb({ applicationId: OTHER_APP, requestorDomain: ORB_SANDBOX_REQUESTOR_DOMAIN }))
    expect(await verifyOrbSession(orbToken())).toBeNull()
    expect((await verifyOrbSession(orbToken(), { allowSandbox: true }))?.account).toBe(ACCOUNT)
  })

  it("refuses tokens Orb refuses, and doesn't ask Orb about ones that aren't JWTs", async () => {
    orbAnswers(Response.json({ status: "FAILED", msg: "Expired Auth" }))
    expect(await verifyOrbSession(orbToken())).toBeNull()
    const fetch = orbAnswers(inOrb())
    expect(await verifyOrbSession("not-a-jwt")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("throws when Orb can't answer, which isn't a sign-out", async () => {
    orbAnswers(new Response("unavailable", { status: 503 }))
    await expect(verifyOrbSession(orbToken())).rejects.toThrow()
  })

  it("reads the session of a request sent with orb.fetch", async () => {
    orbAnswers(inOrb())
    const signed = new Request("http://localhost/api/x", { headers: { Authorization: `Bearer ${orbToken()}` } })
    expect((await getOrbSession(signed))?.account).toBe(ACCOUNT)
    expect(await getOrbSession(new Request("http://localhost/api/x"))).toBeNull()
  })
})

describe("createOrbConvexTokenHandler", () => {
  let privateKey: string
  let convexJwks: JSONWebKeySet

  beforeAll(() => {
    const output = execFileSync("node", ["--import", "tsx", "src/cli/index.ts", "keys"], { encoding: "utf8" }).trim()
    const [pemLine, jwksLine] = output.split("\n")
    privateKey = JSON.parse(pemLine.slice("CONVEX_AUTH_PRIVATE_KEY=".length))
    convexJwks = JSON.parse(Buffer.from(jwksLine.slice("CONVEX_AUTH_JWKS=".length).split(",")[1], "base64").toString())
  })

  const post = (token?: string) =>
    new Request("http://localhost/api/convex-token/orb", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

  it("exchanges an Orb access token for a Convex token for the same Lens account", async () => {
    const session = inOrb()
    orbAnswers(session)
    const res = await createOrbConvexTokenHandler({ privateKey })(post(orbToken()))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const { token } = await res.json()
    // Checked the way Convex does with lensAuthProvider()
    const provider = lensAuthProvider({ jwks: "unused" })
    const { payload } = await jwtVerify(token, createLocalJWKSet(convexJwks), {
      issuer: provider.issuer,
      audience: provider.applicationID,
      algorithms: [provider.algorithm],
    })
    expect(payload.sub).toBe(ACCOUNT)
    expect(payload.exp).toBe(Math.floor(Date.parse(session.expiresAt) / 1000))
  })

  it("answers 401 without a token Orb accepts, and 503 when Orb is unavailable", async () => {
    const POST = createOrbConvexTokenHandler({ privateKey })
    orbAnswers(inOrb())
    expect((await POST(post())).status).toBe(401)
    orbAnswers(Response.json({ status: "FAILED", msg: "Expired Auth" }))
    expect((await POST(post(orbToken()))).status).toBe(401)
    orbAnswers(new Response("unavailable", { status: 503 }))
    const unavailable = await POST(post(orbToken()))
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get("cache-control")).toBe("no-store")
  })
})
