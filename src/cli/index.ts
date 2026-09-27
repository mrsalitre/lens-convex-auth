import { exportJWK, exportPKCS8, generateKeyPair } from "jose"
import { DEFAULT_CONVEX_TOKEN_KEY_ID } from "../core/constants"

const USAGE = `Usage: npx lens-convex-auth keys [--kid <key id>]

Generates the key pair Convex auth tokens are signed with, and prints:
  CONVEX_AUTH_PRIVATE_KEY  set on your server (.env.local, Vercel). Keep it secret.
  CONVEX_AUTH_JWKS         set on your Convex deployment:
                           npx convex env set CONVEX_AUTH_JWKS '<value>'

Generate one pair per environment (dev, prod) and set both halves of a pair together.
Pass --kid only if you also pass the same keyId to createConvexTokenHandler.`

async function keys(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  const pem = await exportPKCS8(privateKey)
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }
  const jwks = JSON.stringify({ keys: [jwk] })
  console.log(`CONVEX_AUTH_PRIVATE_KEY="${pem.trim().replace(/\n/g, "\\n")}"`)
  console.log(`CONVEX_AUTH_JWKS=data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString("base64")}`)
}

const [command, ...args] = process.argv.slice(2)
if (command === "keys") {
  const kidIndex = args.indexOf("--kid")
  await keys(kidIndex >= 0 && args[kidIndex + 1] ? args[kidIndex + 1] : DEFAULT_CONVEX_TOKEN_KEY_ID)
} else {
  console.log(USAGE)
  process.exit(command ? 1 : 0)
}
