import { describe, expect, it } from "vitest"
import { listAccounts } from "../src/react/useAccountPicker"
import { describeUsername } from "../src/react/useCreateAccount"

const owned = (address: string, localName: string | null = null) => ({
  __typename: "AccountOwned" as const,
  account: { address, username: localName ? { localName } : null },
})
const managed = (address: string, localName: string | null = null) => ({
  __typename: "AccountManaged" as const,
  account: { address, username: localName ? { localName } : null },
})

// The fixtures only carry the fields listAccounts reads
type Available = Parameters<typeof listAccounts>[0]

describe("listAccounts", () => {
  it("uses the app's username, falls back to the global one, and leaves out accounts with neither", () => {
    const accounts = listAccounts(
      [owned("0xAAA", "global"), managed("0xBBB", "other"), owned("0xCCC")] as unknown as Available,
      { "0xaaa": "inapp" },
    )
    expect(accounts.map(({ address, username, isOwner }) => ({ address, username, isOwner }))).toEqual([
      { address: "0xAAA", username: "inapp", isOwner: true },
      { address: "0xBBB", username: "other", isOwner: false },
    ])
  })

  it("leaves out an account whose app username is known to be missing, even with a global one", () => {
    const accounts = listAccounts([owned("0xAAA", "global")] as unknown as Available, { "0xaaa": null })
    expect(accounts).toEqual([])
  })

  it("flags usernames more than one account has, and gives each listing its own id", () => {
    const accounts = listAccounts(
      [owned("0xAAA", "same"), managed("0xBBB", "same"), owned("0xCCC", "unique"), managed("0xAAA", "same")] as unknown as Available,
      {},
    )
    expect(accounts.map((account) => account.sharesUsername)).toEqual([true, true, false, true])
    expect(new Set(accounts.map((account) => account.id)).size).toBe(4)
  })
})

describe("describeUsername", () => {
  it("is empty with nothing typed", () => {
    expect(describeUsername("", null, null)).toEqual({ status: "empty" })
  })

  it("reports a format problem before checking availability", () => {
    expect(describeUsername("_alice", null, null)).toEqual({ status: "invalid", message: "Start with a letter or a number" })
  })

  it("is pending until a check for this exact username starts, then checking", () => {
    expect(describeUsername("alice", null, null)).toEqual({ status: "pending" })
    expect(describeUsername("alice", { localName: "alic", status: "available" }, null)).toEqual({ status: "pending" })
    expect(describeUsername("alice", { localName: "alice", status: "checking" }, null)).toEqual({ status: "checking" })
  })

  it("passes on the result of the check", () => {
    expect(describeUsername("alice", { localName: "alice", status: "available" }, null)).toEqual({ status: "available" })
    expect(describeUsername("alice", { localName: "alice", status: "taken" }, null)).toEqual({ status: "taken", message: "This username is taken" })
    expect(describeUsername("alice", { localName: "alice", status: "unknown" }, null)).toEqual({ status: "unknown" })
  })

  it("shows Lens's reason while the rejected username is still typed", () => {
    const rejected = { localName: "alice", message: "Not allowed" }
    expect(describeUsername("alice", { localName: "alice", status: "available" }, rejected)).toEqual({ status: "rejected", message: "Not allowed" })
    expect(describeUsername("alice2", null, rejected).status).toBe("pending")
  })

  it("asks for a username when submitted empty", () => {
    expect(describeUsername("", null, { localName: "", message: "Choose a username" })).toEqual({ status: "rejected", message: "Choose a username" })
  })
})
