// credential_watch.mjs - watch the platform credential contract every
// revision-2 transfer depends on (bd osre-dke).
//
// WHY: registry template revision 2 makes contracts/credential
// (CCDOUOQF...) a DELIBERATE single point of failure - if it is unreachable,
// every mint and transfer on every revision-2 offering (all 20 st01-10
// registries, and every future one) fails CLOSED. That is the correct
// security posture and a real operational risk: at 100 properties, a
// silently archived or broken credential contract is a platform-wide
// transfer outage that looks like "everything is mysteriously denying"
// rather than naming its own cause.
//
// Two checks, both read-only, riding inside mark_cron.mjs twice daily
// (the same pattern capital_drift.mjs established - a cron that already
// runs, watching a thing whose failure mode is silence):
//   1. CANARY READ: get_credential for a wallet known to hold a credential
//      (osre-deployer - granted during the cont. 40 reconciliation, and
//      re-confirmed live 2026-08-19 during the st01-10 funding ceremony).
//      A read that fails ANY way other than the expected record shape
//      means every revision-2 transfer is currently failing closed.
//      Reading a live record also EXTENDS its TTL (the contract's own
//      documented behavior: "reading a live record extends its TTL, so
//      active investors never archive") - so the canary is also upkeep.
//   2. INSTANCE TTL HEADROOM: how many ledgers until the contract instance
//      itself archives. Reads bump persistent entries, but the instance
//      needs its own headroom watched; alert under ~30 days.
//
// Standalone:  node credential_watch.mjs testnet
// Imported:    import { checkCredential } from "./credential_watch.mjs";

import { Contract, Account, TransactionBuilder, scValToNative, Address, nativeToScVal } from "@stellar/stellar-sdk";

// Chain truth: deploy/addresses.credential.testnet.json. Hardcoded here for
// the same reason capital_drift hardcodes TRACKED - this file runs from
// /opt/blend-utils on the VPS where the deploy JSONs are a repo away; the
// address is platform-wide, write-once, and recorded in NOTES.md.
export const CREDENTIAL_ID = "CCDOUOQFVBH6LAYHM45Q3N5HIJGDV4GP5USHNNPQJFFFSTQM3S5YQU42";
// Canary wallet: osre-deployer's pub key - holds a clean platform credential
// (accredited/kyc/jurisdiction 1) since cont. 40; every st01-10 deposit in the
// 2026-08-18 funding ceremony exercised it.
export const CANARY_WALLET = "GAMWXWFZBZWVNHIKPIFUBLPNYQZE32MKFBAPNHSDO426RGUKMENCBKIT";
// Alert when instance TTL headroom drops below this many ledgers (~30 days at
// ~5s/ledger: 30*86400/5 = 518,400).
export const TTL_ALERT_LEDGERS = 518_400;

async function readCall(rpc, passphrase, admin, contractId, fn, args = []) {
  const acct = new Account(admin.publicKey(), "0");
  const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(fn, ...args)).setTimeout(30).build();
  const sim = await rpc.simulateTransaction(tx);
  if (sim.error) throw new Error(`${fn} simulation failed: ${String(sim.error).slice(0, 200)}`);
  return sim.result?.retval !== undefined ? scValToNative(sim.result.retval) : null;
}

/**
 * Returns { ok, problems: string[], canary, ttlHeadroomLedgers }.
 * NEVER throws for a credential-side failure - a monitoring module that
 * throws takes down the mark run it rides in; problems are returned for the
 * caller to report. Throws only on caller-contract misuse.
 */
export async function checkCredential({ rpc, admin, passphrase }) {
  const problems = [];
  let canary = null;
  let ttlHeadroomLedgers = null;

  // 1. canary read - the read every revision-2 registry performs
  try {
    canary = await readCall(rpc, passphrase, admin, CREDENTIAL_ID, "has_credential",
      [nativeToScVal(Address.fromString(CANARY_WALLET), { type: "address" })]);
    if (canary !== true) {
      problems.push(`canary has_credential(${CANARY_WALLET.slice(0, 8)}...) returned ${String(canary)} - expected true; either the credential was revoked/archived or the contract is misbehaving. Every revision-2 transfer is at risk of failing closed.`);
    }
  } catch (e) {
    problems.push(`canary read FAILED outright: ${e.message.slice(0, 200)} - if this persists, every revision-2 mint/transfer on the platform is failing closed right now.`);
  }

  // 2. instance TTL headroom via getLedgerEntries on the contract instance
  try {
    const instanceKey = new Contract(CREDENTIAL_ID).getFootprint();
    const resp = await rpc.getLedgerEntries(instanceKey);
    const latest = resp.latestLedger;
    const entry = resp.entries?.[0];
    if (!entry) {
      problems.push("credential contract instance ledger entry NOT FOUND - the instance may have archived. Revision-2 transfers would fail closed until restored.");
    } else if (entry.liveUntilLedgerSeq != null) {
      ttlHeadroomLedgers = entry.liveUntilLedgerSeq - latest;
      if (ttlHeadroomLedgers < TTL_ALERT_LEDGERS) {
        const days = ((ttlHeadroomLedgers * 5) / 86400).toFixed(1);
        problems.push(`credential instance TTL headroom is ${ttlHeadroomLedgers} ledgers (~${days}d) - below the ~30d alert line. Bump it (any invoke extends, or use \`stellar contract extend\`) before it archives.`);
      }
    }
  } catch (e) {
    problems.push(`instance TTL check failed: ${e.message.slice(0, 200)} (canary result above still stands)`);
  }

  return { ok: problems.length === 0, problems, canary, ttlHeadroomLedgers };
}

/** Telegram ops alert, mirroring capital_drift.pingOps' env contract
 *  (TELEGRAM_BOT_TOKEN + TELEGRAM_OPS_ID from blend-utils' .env) but with a
 *  credential-shaped message - pingOps itself formats drift objects and would
 *  render 'undefined' fields for this module's problems. */
export async function pingCredentialOps(problems) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_OPS_ID;
  if (!problems.length) return { sent: false, reason: "nothing to report" };
  if (!token) return { sent: false, reason: "TELEGRAM_BOT_TOKEN not set in .env - alert path is DEAD" };
  if (!chat) return { sent: false, reason: "TELEGRAM_OPS_ID not set in .env - alert path is DEAD" };
  const body = ["CREDENTIAL SPOF WATCH", ...problems.map((p) => "- " + p), "",
    "Every revision-2 offering's mints and transfers fail CLOSED if this contract is unreachable."].join("\n");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: body }),
  });
  return { sent: res.ok, reason: res.ok ? "sent" : `telegram ${res.status}` };
}

// ---- standalone entry (mirrors capital_drift.mjs's) ----
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const { config } = await import("./lib/utils/env_config.js");
  const r = await checkCredential({ rpc: config.rpc, admin: config.admin, passphrase: config.passphrase });
  console.log(`credential ${CREDENTIAL_ID.slice(0, 8)}...: canary=${r.canary} ttlHeadroom=${r.ttlHeadroomLedgers ?? "n/a"} ledgers`);
  for (const p of r.problems) console.error("  PROBLEM: " + p);
  process.exit(r.ok ? 0 : 1);
}
