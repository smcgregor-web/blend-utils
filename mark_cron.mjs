// mark_cron.mjs - daily NAV re-stamp. Usage: node mark_cron.mjs testnet [--dry-run]
// The Blend pool hardcodes a 24h stale-price wall (pool.rs:126). The adapters are
// not upgradeable, so this cron re-marks each layer daily AT ITS CURRENT PRICE
// (0 bps move - always passes max_change_bps). Sponsor touches NAV only when NAV
// actually changes; this just keeps the timestamp inside the pool's window.
//
// RATIONALE RE-VERIFIED 2026-08-08 (bd osre-bb2, NOTES cont. 29) - the premise
// above is still TRUE for the deployed fleet, and it was checked, not assumed:
//   - "not upgradeable" holds for every LIVE pool-read adapter (all v1-line:
//     no upgrade()/version(), interface-inspected on chain). The v2 TEMPLATE
//     in contracts/oracle-adapter has upgrade() + an egress clamp, but nothing
//     deployed is v2 - a v2+ deploy arrives only via the new-pool path
//     (bd osre-94u), at which point this cron's premise must be re-read.
//   - NO egress clamp on the deployed adapters: lastprice() serves the STORED
//     mark timestamp (probed live), so the pool's 24h wall sees true mark age
//     and this re-stamp IS load-bearing. Not a redundant workaround.
//   - The missed-run warning below is EMPIRICALLY TRUE: the note adapter sat
//     outside LAYERS with a 133.7h-old mark, and a simulated 1-stroop borrow
//     on the note pool trapped Error(Contract, #1210) - a real ~4.6-day
//     origination outage, found and fixed 2026-08-08 (remediation tx
//     770adc61..., post-fix borrow simulates clean). That incident is why the
//     note adapter is now in LAYERS.
import { Contract, Address, nativeToScVal, scValToNative, Account, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "./lib/utils/env_config.js";
import { invokeSorobanOperation, signWithKeypair } from "./lib/utils/tx.js";
import { emitMarkReceipt } from "./emit_mark_receipt.mjs";
import { warmContracts } from "./warm_contracts.mjs";
import { checkCapitalDrift, pingOps } from "./capital_drift.mjs";
const MARKS_FILE = process.env.MARKS_FILE || "/opt/osre/web/marks.json";
const DRY = process.argv.includes("--dry-run");
// Warn when a mark is this old. Sits above the 12h twice-daily cadence (05:00 +
// 17:00 UTC) and well below the pool's 24h wall, so it fires on a MISSED run
// rather than on normal operation.
const STALE_WARN_H = Number(process.env.MARK_STALE_WARN_H ?? 14);
// Layers the pools' HF math actually reads: entry adapter (USDC slot) + HVP
// layer (equity pool) + the note adapter (the NOTE pool's welded oracle,
// pricing OSRE-KMC-SR par for the debt facility - added 2026-08-08 after the
// #1210 outage above; its ledger rows publish as property 'kmcsr').
// NOT here, on purpose: the three KMC tranche SPV oracles (CCAL3OD7/CB7XX5U6/
// CDFOOSBR) hold NO price and no pool reads them - marking empty vestigial
// oracles would manufacture a ledger, not keep one. KMC-MZ/EQ have no
// on-chain mark surface at all today; that gap is RESTATED honestly on the
// standards page + passports rather than papered over (bd osre-bb2).
//
// bd osre-bvd (2026-08-19): the scale-cohort credit facility's 10 individual
// oracle-adapter links (5 in OSREScaleEquity's chain, 5 in OSREScaleDebt's)
// were BUILT and the pools ACTIVATED 2026-08-11/12 - real reserves, real
// wrapper-factories, status 0 (Active), confirmed live - but never added
// here. Found ~8 days stale (both chains) while answering an unrelated
// question, same failure shape as the #1210 outage above, just longer and
// live at the time it was found. Each entry below is ONE property's own
// adapter (glc_mark/set_glc_price take no asset arg - confirmed against the
// deployed contract's own interface before assuming a single multi-asset
// adapter would cover the "5-link chain" language in NOTES.md). All 10 emit
// their own marks.json row - the pool-oracle price is the authoritative one
// for a property that's real collateral, so mark_disclosure.mjs's EXCLUDE
// set was updated the same day to defer to these instead of writing a
// redundant, lower-priority book-value row for the same 10 keys.
const LAYERS = [
  { name: "USD layer / entry (USDC mark)", id: "CDP6FKQU2WJIHHCSHUYWHLLVFQE3WGRF2OT4SO23WC4LD23PD2A6TSC7" },
  { name: "HVP layer", id: "CB5TRW32ZFEYFCA22A7ARCW4OYEKLIDNTWPXH4OA7H25JJO4ZHHXB57X", prop: "hvp", symbol: "OSRE-HVP" },
  { name: "note adapter (KMC-SR par, note-pool oracle)", id: "CCQX6HSU6A434JLRJVYZD7327N73BPJJJ5V4C6ZOQLJMIS6ZUHGCRMBE", prop: "kmcsr", symbol: "OSRE-KMC-SR" },
  // GLC layer, PROP-LESS on purpose (no marks.json rows — like the USD head):
  // the exited Grove's mark prices nothing live, but this adapter sits
  // MID-CHAIN in both pools' delegation paths and its lastprice REVERTS on
  // staleness — an expired GLC mark breaks EVERY full-oracle load on the
  // equity pool (SDK loaders read all reserves and throw on any failure).
  // Found as P1 osre-3gf (2026-08-08): its max_staleness was 30d with nothing
  // re-stamping it. Staleness raised to 1yr (tx 8d826369…) AND it rides this
  // cron so the clock never runs down. Δ=0 re-stamp at its ~$0 mark, always.
  { name: "GLC layer (mid-chain freshness only, ~$0 mark)", id: "CDNXX52LK45YEEPTSKLMKECUQI4ZTQPDRCTKNBY7I66WMAL6LJY2XTPG" },
  // OSREScaleEquity chain (added 2026-08-19, bd osre-bvd) — 5 links, each its
  // own adapter with its own stored mark; st10's is the pool's oracle pointer
  // (the "head" the pool calls directly) but staleness is per-property, not
  // chain-wide, so all 5 need their own re-stamp, not just the head.
  { name: "scale-equity: st06 (Northgate Storage Yards)", id: "CAYKZVOR2GAZXB4TZTHZ45BPJCBOL4JPK66GYHLTJ6ZH644BEFBXXTSB", prop: "st06", symbol: "OSRE-ST06" },
  { name: "scale-equity: st07 (Prairie Vista Flex Campus)", id: "CARHLJJOOAJOJ7LW27WET7W27IMHU3WPR5GXBF5Z2AS4LYKHNRJETDGP", prop: "st07", symbol: "OSRE-ST07" },
  { name: "scale-equity: st08 (Ironwood Logistics Hub)", id: "CAMP77647CAU2TLK6BHVT3C3PT4DKE2FSDLYV5PC7I54GGMKJPAY7X26", prop: "st08", symbol: "OSRE-ST08" },
  { name: "scale-equity: st09 (Millrace Commons)", id: "CC4TWQBEC3PDQX7OJOVYPKSECGKYH3RLCBBBVLSTKQMDGTZO7PYWSK7U", prop: "st09", symbol: "OSRE-ST09" },
  { name: "scale-equity: st10 (Cobalt Crossing Business Park, pool oracle pointer)", id: "CCPELDAIQMROZ4XDO6H6HTS3ECSBOUQI7RB3PF3CZCNLBIYFWZ4XIPQL", prop: "st10", symbol: "OSRE-ST10" },
  // OSREScaleDebt chain (added 2026-08-19, bd osre-bvd) — same 5-independent-
  // links structure; st05sr's adapter is the pool's oracle pointer.
  { name: "scale-debt: st01sr (Cascade Commerce Center - Senior Note)", id: "CD2A3IUZSYA3COCPJAVEO66RJXHDJCO6TJX2XKWMYUYYDQ7NHQCFCSM4", prop: "st01sr", symbol: "OSRE-ST01-SR" },
  { name: "scale-debt: st02sr (Ridgeline Medical Plaza - Senior Note)", id: "CBZRI74E64OB6Z7HYA3LO6I4LLWTJ35FBSHT7FQ7GZ5TFI3NPMRODWBX", prop: "st02sr", symbol: "OSRE-ST02-SR" },
  { name: "scale-debt: st03sr (Union Point Industrial - Senior Note)", id: "CC5PWSKPAQRQ4553JLFLVZGMKWK6AML3F3G4Y6QVNOVWLCLGKXJFASSG", prop: "st03sr", symbol: "OSRE-ST03-SR" },
  { name: "scale-debt: st04sr (Sable Creek Retail - Senior Note)", id: "CD7XYMZ5YIEU5XXZL7FN4NDLYNXHIHWTB2XQXVTXA3PUCGQVIVOLFE7R", prop: "st04sr", symbol: "OSRE-ST04-SR" },
  { name: "scale-debt: st05sr (Founders Row Office Park - Senior Note, pool oracle pointer)", id: "CDALF2PG45JUMC5YBIH5O5X2AVH2VDVUMRFB2Q5SWQCDZMTL7MREM72S", prop: "st05sr", symbol: "OSRE-ST05-SR" },
];
const admin = config.admin;
const txp = async (kp) => ({
  account: await config.rpc.getAccount(kp.publicKey()),
  txBuilderOptions: { fee: "10000", timebounds: { minTime: 0, maxTime: 0 }, networkPassphrase: config.passphrase },
  signerFunction: async (x) => signWithKeypair(x, config.passphrase, kp),
});
async function read(cid, fn, args = []) {
  const acct = new Account(admin.publicKey(), "0");
  const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: config.passphrase })
    .addOperation(new Contract(cid).call(fn, ...args)).setTimeout(30).build();
  const sim = await config.rpc.simulateTransaction(tx);
  if (sim.error) throw new Error(`read ${fn} @ ${cid.slice(0, 8)} failed: ${String(sim.error).slice(0, 200)}`);
  return sim.result?.retval !== undefined ? scValToNative(sim.result.retval) : null;
}
console.log(`MARK DAY ${new Date().toISOString()}${DRY ? " [DRY RUN]" : ""}`);
const now = Math.floor(Date.now() / 1000);
for (const L of LAYERS) {
  const who = await read(L.id, "admin");
  if (String(who) !== admin.publicKey()) {
    throw new Error(`${L.name}: adapter admin is ${String(who).slice(0, 8)}... but blend-utils ADMIN is ${admin.publicKey().slice(0, 8)}... - wrong key, refusing`);
  }
  const mark = await read(L.id, "glc_mark");
  if (!mark || BigInt((mark.price ?? 0).toString()) <= 0n) {
    throw new Error(`${L.name}: no valid local mark to refresh (price ${mark?.price ?? "none"}) - set NAV manually first`);
  }
  const price = BigInt(mark.price.toString());
  const ageH = ((now - Number(mark.timestamp)) / 3600).toFixed(1);
  console.log(`${L.name}: price $${(Number(price) / 1e7).toFixed(4)}, mark age ${ageH}h`);
  // The pool's wall is 24h (pool.rs:126). A once-daily cadence sits ~1 minute
  // from stale right before every run, so a single missed run silently breaks
  // borrow origination (#1210) until someone notices. Say so out loud.
  if (Number(ageH) >= STALE_WARN_H) {
    console.error(`  *** STALE RISK: ${L.name} mark is ${ageH}h old (pool wall 24h). A run was missed or delayed - check the crontab and /var/log/osre-marks.log ***`);
  }
  if (DRY) continue;
  let txHash = null;
  const origLog = console.log;
  console.log = (...a) => {
    const m = /Transaction Hash: ([0-9a-f]{64})/i.exec(a.join(" "));
    if (m) txHash = m[1].toLowerCase();
    origLog(...a);
  };
  try {
    await invokeSorobanOperation(
      new Contract(L.id).call("set_glc_price", nativeToScVal(price, { type: "i128" })).toXDR("base64"),
      () => undefined, await txp(admin));
  } finally { console.log = origLog; }
  console.log(`  re-stamped at same price`);
  if (L.prop && txHash) {
    try {
      const rec = await emitMarkReceipt({
        date: new Date().toISOString().slice(0, 10),
        property: L.prop, symbol: L.symbol,
        price: String(Number(price) / 1e7),
        tx: txHash, file: MARKS_FILE,
      });
      console.log(`  receipt ${rec.written ? "emitted" : "skipped (" + rec.reason + ")"} -> ${MARKS_FILE}`);
    } catch (e) {
      console.error(`  RECEIPT ERROR (mark succeeded, ledger row NOT written): ${e.message}`);
    }
  } else if (L.prop && !txHash) {
    console.error(`  RECEIPT ERROR: tx hash not captured from submission log - ledger row NOT written`);
  }
}
// --- WARM PASS (2026-08-06) -------------------------------------------------
// The adapters above stay warm as a side effect of being written to daily.
// Nothing was doing that for the distribution/settlement/coordinator contracts,
// which are touched only at monthly ceremonies - so they archive between runs.
// (Found live: the whole Kestrel stack sat ~2.2 days from archiving with
// stack_cron 25 days away; glc distribution had already expired.)
//
// Deliberately LAST and fully isolated: a warming failure must never mask or
// undo a successful mark. The mark is the obligation; warming is hygiene.
try {
  console.log("WARM PASS (keeping monthly-touched contracts out of the archive)");
  const { warmed, failed, currentLedger } = await warmContracts({
    rpc: config.rpc, admin, txp, invoke: invokeSorobanOperation, passphrase: config.passphrase, dry: DRY,
  });
  console.log(`  ledger ${currentLedger}: ${warmed} warmed, ${failed} failed`);
  if (failed) console.error(`  WARN: ${failed} contract(s) failed to warm - they will be retried tomorrow`);
} catch (e) {
  console.error(`WARM PASS ERROR (marks above are unaffected): ${e?.message ?? e}`);
}

// --- CAPITAL BASE DRIFT (2026-08-07) ----------------------------------------
// Pref accrues on contributed_capital, so a basis behind live supply means the
// CHAIN under-records what investors are owed. `add_capital` accrues pref first,
// so a gap left open is never back-paid - late truing forfeits it permanently.
// Reporting twice a day makes "true at subscription" enforceable instead of
// remembered. Read-only; pings the sponsor DM (ops rail), never the channel.
try {
  console.log("CAPITAL BASE DRIFT");
  const { drifted } = await checkCapitalDrift({ rpc: config.rpc, admin, passphrase: config.passphrase });
  if (drifted.length) {
    const r = await pingOps(drifted);
    console.error(`  ${drifted.length} tranche(s) drifted — ${r.reason}`);
  }
} catch (e) {
  console.error(`CAPITAL DRIFT ERROR (marks + warm pass above are unaffected): ${e?.message ?? e}`);
}

console.log("MARK DAY COMPLETE");
