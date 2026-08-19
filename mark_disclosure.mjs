// mark_disclosure.mjs - daily book-value NAV disclosure mark for every
// non-exited property NOT already covered by mark_cron.mjs's pool-oracle
// re-stamp. Usage: node mark_disclosure.mjs testnet [--dry-run]
//
// WHY THIS IS A SEPARATE SCRIPT FROM mark_cron.mjs, ON PURPOSE:
// mark_cron.mjs's LAYERS are pool-collateral FRESHNESS marks - a missed run
// there trips the Blend pool's 24h staleness wall and blocks real borrow
// origination (see that file's header for the #1210 outage history). That
// is a load-bearing, safety-critical mechanism for exactly 2 properties
// (hvp, kmcsr) whose oracle-adapters a live credit pool actually reads.
//
// This script is PURE DISCLOSURE - an investor-facing NAV history for
// every OTHER non-exited property, none of which have (or need) a credit
// pool reading them. A bug here must never be able to touch a pool's
// staleness wall, so this reads/writes nothing mark_cron.mjs touches: no
// SEP-40 oracle-adapter contracts, no pool-read oracles. Instead it reads
// each property's own settlement.share_price() (the book-value NAV -
// nav()/total_supply, already the authoritative number this platform uses
// everywhere else) and receipts it via a manageData entry on the sponsor
// account - the SAME anchoring pattern osre-distribution/anchor_diligence.mjs
// already uses for diligence packages, not the heavier oracle-adapter/pool
// machinery mark_cron.mjs depends on.
//
// SUPERSEDES, IN PART: NOTES.md's "Junior-tranche mark surface" section and
// bd osre-wck decided (2026-08-17, rationale corrected 2026-08-18) that
// KMC-MZ/EQ deliberately carry no mark surface because no credit facility
// reads them as collateral. That finding is still TRUE and still the
// reason those two (and every st01-10 tranche) have no SEP-40 oracle-
// adapter - this script doesn't build one. What changed: the founder asked
// (2026-08-18) for every non-exited property to show an active NAV history
// on the disclosure ledger regardless of pool-collateral status. Both
// things are true at once: no pool needs a price for these tranches, AND
// investors reading osre-marks.html should see one anyway. This script is
// the honest way to do the second without pretending the first changed.
//
// Deliberately excludes hvp and kmcsr - they keep their existing, more
// rigorous pool-oracle-anchored marks from mark_cron.mjs. Two separate
// mechanisms, explicit non-overlapping ownership, not a silent dedup.
//
// SIGNER: osre-deployer, NOT blend-utils' own config.admin (a DIFFERENT
// account - blend-utils' pool-admin identity, unrelated to the OSRE
// sponsor account every other manageData anchor in this repo uses -
// anchor_diligence.mjs's "verify against the sponsor account" and this
// exact page's own diligence-verification links all point at
// osre-deployer specifically). Using a third, unfamiliar account here
// would be a real inconsistency, not just a style choice - a reader
// following the same verification habit the diligence panel already
// taught them would land on the wrong address. config.rpc/config.passphrase
// (blend-utils' own env) are still used for the READ-ONLY share_price()
// simulation, which needs no real signer at all.
//
// Secret comes from OSRE_DEPLOYER_SECRET, not a `stellar keys` CLI lookup -
// this script's production home (/opt/blend-utils on the VPS) is not known
// to have that CLI identity registered, whereas the raw secret already sits
// in osre-custody's own .env as OSRE_OPERATOR_SECRET (same key, confirmed
// in NOTES.md as "= osre-deployer S-key"). Duplicating the value into
// blend-utils' own .env under this name is the same pattern already used
// for the Telegram bot token across 4 separate .env files - simple,
// explicit, no cross-service file reads baked into either script.
import { readFileSync, existsSync } from 'node:fs';
import * as SDK from '@stellar/stellar-sdk';
import { config } from './lib/utils/env_config.js';
import { emitMarkReceipt } from './emit_mark_receipt.mjs';
const { Contract, Account, Keypair, TransactionBuilder, Operation, Networks, BASE_FEE, scValToNative } = SDK;

const HORIZON = 'https://horizon-testnet.stellar.org';
const MARKS_FILE = process.env.MARKS_FILE || '/opt/osre/web/marks.json';
const PROPERTIES_JS = process.env.PROPERTIES_JS || '/opt/osre/web/properties.js';
const DEPLOY_DIR = process.env.DEPLOY_DIR || '/opt/osre/deploy';
const DRY = process.argv.includes('--dry-run');
const PRICE_SCALE = 10_000_000n;

if (!process.env.OSRE_DEPLOYER_SECRET) {
  console.error('OSRE_DEPLOYER_SECRET is required (osre-deployer S-key - same value as osre-custody/.env\'s OSRE_OPERATOR_SECRET). Refusing to sign with a different identity.');
  process.exit(1);
}
const signer = Keypair.fromSecret(process.env.OSRE_DEPLOYER_SECRET);

// Same mechanism the mark surfaces themselves already trust hvp/kmcsr for -
// those two stay on mark_cron.mjs's pool-oracle-anchored mechanism.
const EXCLUDE = new Set(['hvp', 'kmcsr']);

function loadProperties() {
  const raw = readFileSync(PROPERTIES_JS, 'utf8').replace(/^﻿/, '');
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func -- same read-only pattern used
  // throughout this session's own verification scripts; properties.js is a
  // static, repo-controlled catalog file, not user input.
  new Function('window', raw)(sandbox.window);
  return sandbox.window.OSRE_PROPERTIES ?? {};
}

async function readSharePrice(cid) {
  const acct = new Account(signer.publicKey(), '0'); // read-only simulate source; no signature needed
  const tx = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: config.passphrase })
    .addOperation(new Contract(cid).call('share_price')).setTimeout(30).build();
  const sim = await config.rpc.simulateTransaction(tx);
  if (sim.error) throw new Error(`share_price @ ${cid.slice(0, 8)} failed: ${String(sim.error).slice(0, 200)}`);
  return BigInt(scValToNative(sim.result.retval).toString());
}

console.log(`MARK DISCLOSURE ${new Date().toISOString()}${DRY ? ' [DRY RUN]' : ''}`);
const props = loadProperties();
// A genuinely empty/malformed properties.js (parse failure, unexpected shape,
// a bad PROPERTIES_JS path) must NOT look identical to "every property is
// exited today" - both currently produce targets.length === 0, but only one
// of them is a real failure a cron running this should surface loudly.
if (!Object.keys(props).length) {
  console.error(`FATAL: loadProperties() returned no properties at all from ${PROPERTIES_JS} - refusing to treat this as "nothing to mark". Check the file exists and parses.`);
  process.exit(1);
}
const targets = Object.values(props).filter(p => (p.lifecycle ?? 'operating') !== 'exited' && !EXCLUDE.has(p.key));
console.log(`${targets.length} non-exited, non-pool-owned properties to mark`);

const date = new Date().toISOString().slice(0, 10);
const rows = []; // { key, symbol, priceStr }
let readErrors = 0;
for (const p of targets) {
  const addrPath = `${DEPLOY_DIR}/addresses.${p.key}.testnet.json`;
  if (!existsSync(addrPath)) { console.error(`  ${p.key}: SKIP - no ${addrPath}`); readErrors++; continue; }
  const addrs = JSON.parse(readFileSync(addrPath, 'utf8').replace(/^﻿/, ''));
  const settlement = addrs.contracts?.settlement;
  if (!settlement) { console.error(`  ${p.key}: SKIP - no settlement contract in address file`); readErrors++; continue; }
  try {
    const raw = await readSharePrice(settlement);
    // Same formatting convention as mark_cron.mjs's own emitMarkReceipt call
    // (String(Number(price) / 1e7)) - matched deliberately so marks.json
    // doesn't carry two different price-string shapes for the same scale.
    const priceStr = String(Number(raw) / Number(PRICE_SCALE));
    console.log(`  ${p.key}: share_price = $${priceStr}`);
    rows.push({ key: p.key, symbol: p.symbol, priceStr });
  } catch (e) {
    console.error(`  ${p.key}: READ ERROR - ${e.message}`);
    readErrors++;
  }
}
// A run where EVERY target failed to read is a failure, not "nothing to
// mark" - the latter only means today's catalog happens to have zero
// eligible properties, which read/write success on zero targets covers
// fine. Distinguish them by exit code so a cron (or a human re-running by
// hand) can tell "ran clean, nothing due" from "something is broken".
if (!rows.length) {
  if (targets.length > 0 && readErrors === targets.length) {
    console.error(`FATAL: all ${targets.length} target(s) failed to read - exiting nonzero rather than reporting a silent success.`);
    process.exit(1);
  }
  console.log('nothing to mark - exiting');
  process.exit(0);
}
if (DRY) { console.log(`[dry run] would anchor ${rows.length} marks in one transaction`); process.exit(0); }

// ---- one manageData op per property, one transaction, one shared tx hash ----
// (same pattern as anchor_diligence.mjs: atomic, cheap, and every mark from
// this run is verifiably set at the same moment.)
const acctRes = await fetch(`${HORIZON}/accounts/${signer.publicKey()}`);
if (!acctRes.ok) { console.error('horizon account fetch failed', acctRes.status); process.exit(1); }
const acctJson = await acctRes.json();
const source = new SDK.Account(signer.publicKey(), acctJson.sequence);
let b = new TransactionBuilder(source, { fee: (Number(BASE_FEE) * rows.length * 4).toString(), networkPassphrase: Networks.TESTNET });
for (const r of rows) {
  b = b.addOperation(Operation.manageData({ name: `mark:${r.key}:${date}`, value: r.priceStr }));
}
const tx = b.setTimeout(120).build();
tx.sign(signer);
const submit = await fetch(`${HORIZON}/transactions`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'tx=' + encodeURIComponent(tx.toEnvelope().toXDR('base64')),
});
const sj = await submit.json();
if (!sj.hash || sj.successful === false) {
  console.error('submit failed:', JSON.stringify(sj.extras?.result_codes ?? sj).slice(0, 300)); process.exit(1);
}
console.log(`anchored on-chain: tx ${sj.hash} (${rows.length} manageData ops)`);

for (const r of rows) {
  try {
    const rec = await emitMarkReceipt({ date, property: r.key, symbol: r.symbol, price: r.priceStr, tx: sj.hash, file: MARKS_FILE });
    console.log(`  ${r.key} receipt ${rec.written ? 'emitted' : 'skipped (' + rec.reason + ')'} -> ${MARKS_FILE}`);
  } catch (e) {
    console.error(`  ${r.key} RECEIPT ERROR (mark succeeded, ledger row NOT written): ${e.message}`);
  }
}
console.log('MARK DISCLOSURE COMPLETE');
