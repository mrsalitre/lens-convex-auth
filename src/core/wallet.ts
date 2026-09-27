import { createWalletClient, custom, defineChain as defineViemChain, getAddress, hexToBigInt, hexToNumber, type Account as ViemAccount, type Chain as ViemChain, type Hex, type Transport, type WalletClient } from "viem"
import { lens as viemLens, lensTestnet as viemLensTestnet } from "viem/chains"
import { chainConfig } from "viem/zksync"
import { defineChain, type Chain } from "thirdweb/chains"
import { EIP1193, type Wallet } from "thirdweb/wallets"
import type { ThirdwebClient } from "thirdweb"
import { LENS_CHAIN_IDS, type LensEnvironmentName } from "./constants"

// Lens Chain for thirdweb. Without an RPC URL thirdweb uses its own RPC for the chain.
export function lensThirdwebChain(environment: LensEnvironmentName, rpcUrl?: string): Chain {
  const testnet = environment === "testnet"
  return defineChain({
    id: LENS_CHAIN_IDS[environment],
    name: testnet ? "Lens Chain Testnet" : "Lens Chain",
    nativeCurrency: testnet
      ? { name: "GRASS", symbol: "GRASS", decimals: 18 }
      : { name: "GHO", symbol: "GHO", decimals: 18 },
    ...(rpcUrl ? { rpc: rpcUrl } : {}),
    ...(testnet ? { testnet: true as const } : {}),
  })
}

// Lens Chain with the zkSync config (same as `chains.mainnet` from @lens-chain/sdk/viem), so viem can
// sign the sponsored EIP-712 transactions the Lens API returns. Typed as a plain `Chain` because
// `handleOperationWith` takes a plain viem `WalletClient`.
export function lensViemChain(environment: LensEnvironmentName): ViemChain {
  return defineViemChain({ ...(environment === "testnet" ? viemLensTestnet : viemLens), ...chainConfig })
}

// A viem wallet client for the connected thirdweb wallet, as `handleOperationWith` expects:
// hoisted account and a Lens chain. Works for every thirdweb wallet, not only injected ones.
export function createLensWalletClient(opts: {
  wallet: Wallet
  client: ThirdwebClient
  chain: Chain
  viemChain: ViemChain
}): WalletClient<Transport, ViemChain, ViemAccount> {
  const account = opts.wallet.getAccount()
  if (!account) throw new Error("Connect your wallet")
  const provider = EIP1193.toProvider({ wallet: opts.wallet, chain: opts.chain, client: opts.client })
  return createWalletClient({
    account: getAddress(account.address),
    chain: opts.viemChain,
    transport: custom({
      request: ({ method, params }) => {
        if (method === "eth_sendTransaction") {
          // viem sends hex-encoded fields (e.g. `type: "0x2"`) that thirdweb's local signers reject.
          // thirdweb re-estimates gas and fees for Lens Chain anyway, so pass only what it needs.
          const [tx] = params as [{ to: Hex; data?: Hex; value?: Hex; nonce?: Hex }]
          return provider.request({
            method,
            params: [{
              to: tx.to,
              data: tx.data,
              value: tx.value ? hexToBigInt(tx.value) : undefined,
              nonce: tx.nonce ? hexToNumber(tx.nonce) : undefined,
            }],
          })
        }
        return provider.request({ method, params })
      },
    }),
  })
}
