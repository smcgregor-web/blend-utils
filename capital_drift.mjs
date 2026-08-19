// capital_drift.mjs - watch contributed_capital against live token supply.
//
// WHY (2026-08-06/07): HVP's distribution contract recorded a $2,875,000 basis
// while $6,160,000 had actually been subscribed. The preferred return accrues on
// contributed_capital, so the CHAIN was under-recording what investors were owed
// by $495/day - on a platform whose pitch is "audit our chain."
//
// Worse, `add_capital` accrues pref FIRST, so truing late does not back-pay the
// gap period. Capital that sat un-based earns NOTHING, permanently. The standing
// rule was "re-true before each distribution"; that is TOO LATE. The rule is now
// TRUE AT SUBSCRIPTION - and this module is what makes that enforceable, by
// making the gap impossible to grow silently.
//
// PAYMENTS ARE NOT AFFECTED. Rent and coupons compute from token balance x rate.
// What drifts is outstanding_pref - the books, and the number the public accrual
// ticker reads.
//
// RELATIONSHIP TO REGISTRY TEMPLATE REVISION 2 (bd osre-f41, 2026-08-09)
// ---------------------------------------------------------------------
// Offerings deployed from revision 2 and WIRED (settlement <-> distribution) raise the
// basis inside the mint transaction, so their gap is zero by construction and this watch
// should never fire for them. It is deliberately NOT switched off for those offerings:
// a wired offering that starts drifting means the wiring broke, which is exactly the
// thing worth an alert. Silence here is the signal; keep the watch pointed at them.
//
// The supply-vs-basis comparison below assumes PAR ($1) issuance, and that assumption is
// CONVENTIONAL, not enforced - on wired and unwired offerings alike. A draft of revision 2
// did enforce it by refusing off-par mints; that guard was removed as a critical defect
// (a permissionless one-stroop `burn` made it brick the raise permanently). So both of
// these can legitimately break the equality without anyone doing anything wrong:
//   * mark_nav_gain -> share price > 1.0 -> a later deposit mints fewer tokens than the
//     USDC it contributed, so basis (USDC) exceeds supply -> the "OVER" branch fires.
//   * burn (permissionless, any holder) -> supply drops, basis does not -> "OVER" again.
// Before acting on an OVER alert, read that offering's share_price and check for burns.
// OVER is "look at this", not "something is wrong" - and it is still worth alerting on,
// because the third cause of OVER is a basis that was over-trued, which IS wrong.
//
// Attribution note: off par, the USDC basis is the right AGGREGATE but the waterfall
// still returns capital pro-rata by TOKEN, so per-holder amounts are approximate. That
// limitation predates revision 2 and is filed as its own work item (per-holder capital
// accounting); revision 2 improves the aggregate and does not worsen attribution.
// DESIGN SETTLED 2026-08-19 (bd osre-2lw): osre-per-holder-attribution-design.md
// specifies the v2 fix (basis-proportional ROC, template-only, one named open
// question reserved for the audit gate). The OVER alert below is the live
// watch for the precondition (off-par + multiple holders = per-holder ROC
// misattribution risk on the next distribution) - see that doc before acting.
//
// Standalone:  node capital_drift.mjs testnet
// Imported:    import { checkCapitalDrift } from "./capital_drift.mjs";

import { Contract, Account, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";

// Report any gap at or above this many dollars. Small enough to catch a real
// subscription, large enough to ignore rounding.
export const DRIFT_THRESHOLD_USD = 1;

// LIVE offerings only. Exited properties are deliberately absent: their basis
// is final and a "gap" there is history, not drift. That exclusion is now
// EXPLICIT (see EXITED below) rather than expressed by omission, because
// omission and oversight look identical in a hand-maintained list — and the
// cost of an oversight here is permanent (see the header: pref that accrues
// against an un-trued basis is never back-paid).
//
// `osre-series validate` enforces that every offering appears in EXACTLY ONE
// of TRACKED / EXITED (V23-V25), so omission from this file becomes a NAMED
// failure at onboarding instead of silence. Three honest limits on that claim:
//   1. The gate is a RUNBOOK step (ONBOARDING-OFFERINGS.md section 0), not
//      something deploy_property.ps1 invokes - a deploy that skips the gate
//      skips this check too.
//   2. EXITED is a self-assertion. Nothing cross-checks it against chain state
//      (no total_supply == 0 probe), so listing a LIVE offering here silences
//      its watch and the gate will applaud. Only ever move a key here at a real
//      exit.
//   3. FORMAT IS LOAD-BEARING: the parser reads ONE ENTRY PER LINE. Running a
//      formatter that wraps these objects across lines breaks the gate loudly
//      (V25 on every offering) - which is the safe direction, but do not be
//      surprised by it.
export const TRACKED = [
  { key: "st05eq", token: "CDQMLLRWJMEYWUJ36KC7RBCTZMYSMW2PRI43T7GU7TINMMLFSQTYUP6D", dist: "CBSTGAMNRGQESZOBWIFO72YHLFSW4M7KFUGPFQ4PTNQGFSJX4PHRM37E", truer: "ceremony_add_capital.mjs" },
  { key: "st05mz", token: "CBSJWBQ2JBIHFJGFS2YUNEYC6OTQVPOVBI544EFASFPTXHLY5ATR3QX2", dist: "CAEOHQBGRQLJNQ5GFLG5ZQ43WMTCCNYJQWCJRWUVAM7TI342NNEDWGTR", truer: "ceremony_add_capital.mjs" },
  { key: "st05sr", token: "CA7OJDQRRMTD7XG6PEBNI32SEMOAYP7NS3GYBT6QKXGEAYK4TG2I3E6A", dist: "CBG6IEWFWOIOFSBFVDOCI2WSYT6KDCDRPBD2FQCXHNA3CGJR3TFKDMYY", truer: "ceremony_add_capital.mjs" },
  { key: "st04eq", token: "CCMYVHGABBQKLOMCOJ2CT5FCBYQDYYELENCL2SLA6ISSXXCF4BQYPLHS", dist: "CBSEKEV5AASLULFK36SB2FOFMB64GHYJHFCTZBDN7DKX6MI5YGEJNI4W", truer: "ceremony_add_capital.mjs" },
  { key: "st04mz", token: "CC2FTCV45FGGBDIYVX3VQYAJ7DONDLNKYUITEWDMLCDLPBHFEBRBIWB3", dist: "CDKYPUWLDJABDIDFDQX5A25OAHLXZBIM2OQJXFYPVY3RGKRGRYK4QTGU", truer: "ceremony_add_capital.mjs" },
  { key: "st04sr", token: "CCT3ODBYPZNYFAWXSVGWONYJ5BKDU3MGXIK45QETP3ICUB2SYZLT7OOR", dist: "CD7XSGFJOVWTW2CXUY64OJJ2YCTDC7HQMWYQDLP6RD2PY4I5TJUNC7SX", truer: "ceremony_add_capital.mjs" },
  { key: "st03eq", token: "CCZUYKOMGTGIF3DXLYABXZROVKWUFLZWXQ2TEY2DAPBYVARN4JXP6KX5", dist: "CDDYW5IV3WH7N4DX6AGIR6OZQQZH3ASMYAVXHGODTHXITRJSGABRDTTD", truer: "ceremony_add_capital.mjs" },
  { key: "st03mz", token: "CB4OBWAXS4PBR2RBBMYEN5PMQTQTYBCMOWGDVSYVY5BVDZDL66HWO7JL", dist: "CBWVRTFPHTHMXGUEDXPLDB6CQMGDSICNSHO5YMOD22GKUFJA2CPO4OV4", truer: "ceremony_add_capital.mjs" },
  { key: "st03sr", token: "CBZ3HFT4NKYX24XR2EUMGZ6OQQORM66VL464SYEN456PNXPC2HJBNKUH", dist: "CD5AT7VHACSWTWR5ZZQ5Q5QDSLMV5DU67JD4YP4NLXKG5RUAHYH3EXH4", truer: "ceremony_add_capital.mjs" },
  { key: "st02eq", token: "CBINTYEKUHXRB7E7MCTBEMGTK6N57DJUYKI7UTSFZZXGHBFFSFX7QIKD", dist: "CAXA7SXU5IAXQLCKUAZMOPHZGZI7AVBQCPSHX5S6QMLSGOQU2CHNKMOI", truer: "ceremony_add_capital.mjs" },
  { key: "st02mz", token: "CBBGFXCAUVB4EPYAEPW5NAH43HBEIWG2ICCYKZBXIYOX67SMOA4UQOY2", dist: "CAKOEWHHGD5GGYDDGOIAHLWZADADWI2GTE4YJSMQXWTWUEIAEND7MSSN", truer: "ceremony_add_capital.mjs" },
  { key: "st02sr", token: "CB64NNJCBXJP4BKH2I7UPAFFUHDFLKUWY32UZEIFIWAYZ3JRXPVJ5EC6", dist: "CDGKEJDIKEHCHUB7DUUAFHNNOMAA5YRHY72XV5REAU4SHJR55SU2XO6J", truer: "ceremony_add_capital.mjs" },
  { key: "st01eq", token: "CC62U6A4UUNS6OFK3HYZ6BMIH4I3FLWWW6FRKBKCP6XXWNBFZOSWQOW3", dist: "CDS2JPJNT6JFY4OHJTLQ4JKRML2EP5NBBMXMLBQIRO4ASGZBMQ4SKMA2", truer: "ceremony_add_capital.mjs" },
  { key: "st01mz", token: "CAUAOTVTVOHLIFFJC7KL25W2TZ7CTY7P25A6GZPRBLEMXG7RTWLOI4YX", dist: "CDYA4LE25UMSUYZNFEU35N77LZHZSQYJOJRGSDC5RMMSTHJRIYWCRCTE", truer: "ceremony_add_capital.mjs" },
  { key: "st01sr", token: "CDERDNG4UL5GC3K3AZ6CLRABDTJRKH6DK5I2L7PJLYVWFGB46DRHDX74", dist: "CCAUFIMSS4CUIPPKPOV74OFUGWKHJAOPKQSOLCPNPFF7ES74VZGHO7KA", truer: "ceremony_add_capital.mjs" },
  { key: "st10", token: "CBCQLPQY7P4LA7XXQLAL3KDFHYVBEKWT7HCQHM5MS7PRGXGIO2UM32YT", dist: "CCA4FGGMWZMD4RYYBLNPJ55FWDHWRQSA55RRZU4E4NJGUASZ2OZFOZQN", truer: "ceremony_add_capital.mjs" },
  { key: "st09", token: "CCINKXBJKP37PRTT5RN4UGBKSTRD4MNWSSG2PIYQNFLUDQXFWUZ7RVIM", dist: "CA7NPSBJIQTVIZF7L4GOBQ7FORLNAC64BAMMARWHS6XFKX56DHERI2OM", truer: "ceremony_add_capital.mjs" },
  { key: "st08", token: "CBYE2HIPHKZ452HFYTARJKYAHKDSB2F2VUE6UGKRTDDI3ZYZUE6VJ3Z4", dist: "CCQ7Z43FIFADZ64KVNH4E5W6VOEI24FG3F3W5HMMLSYRWWUUTTGHCYOT", truer: "ceremony_add_capital.mjs" },
  { key: "st07", token: "CBSX3S2ATKGEACTRTEL2GMMPZXLKQDXC3DJIHFGIODBRJTDUD4YFVZGK", dist: "CBRTIWXWL63PMLJ4XS24ZUTUKMRI3CYDKNW7URIWH6LEGPBTZPK2UXR7", truer: "ceremony_add_capital.mjs" },
  { key: "st06", token: "CDFNNF3UVBUAIWXT4GJT3JJ6Y7LFDKF3JXT5C53GL6EMHEZBCC7JKUJW", dist: "CDE7X4GEQ3V6JFGNY5P6OECZI6X6BX66YL7T6VELOHOM5NNY6Y643QTM", truer: "ceremony_add_capital.mjs" },
  { key: "hvp",   token: "CBMN4Q7BRMZ2KLSFFJ3YR2A3IBHECA26Q7H2R6EIWQSCCSCTCDLPDFMW", dist: "CAUPW5RK673BRPH5TQV2IKSPZGNOAFRHTQO5CPSPLZGTZQSUXK2RN433", truer: "true_capital.js" },
  { key: "kmcsr", token: "CBFHGHCKUQU7ELKNFCWFWYFHH3UD4S5DLM7OUWYFKN742QOBRZRVWXZL", dist: "CCLJLDR54VK3RGABA3OISAS7J7YJNPBS3CD4IFVH7TUE3NL26VGJQKA5", truer: "ceremony_add_capital.mjs" },
  { key: "kmcmz", token: "CCGFHMVMHYXERKOQRXZ5INU7ANWZSUKP6HHMBNJ6GOGY37PB4SY5OYBW", dist: "CAHPCNQXFR4P267BD23FNOY2QQ6Y7IZZVAJSCQOPDID7TOHZKUEO4PUF", truer: "ceremony_add_capital.mjs" },
  { key: "kmceq", token: "CDYPSDYLY7SGJ7C3FE6G77GIHUP44WHXDCYFCDZ6CUYQULJW4KBQEZ2C", dist: "CBDNCY4SV2D7KBX5UNSEPTRFQ3YDV465YRK5Z6A26EA26JVVXD6VRPXR", truer: "ceremony_add_capital.mjs" },
];

// Offerings deliberately NOT drift-tracked because their basis is FINAL.
// This is the other half of the classification the gate enforces: an offering
// listed here is asserted to be settled, not forgotten. Moving a property here
// is what EXITING it means operationally — remove it from TRACKED in the same
// edit, or the gate flags the contradiction.
// Runtime behaviour is unchanged: nothing in this module reads EXITED. It
// exists so the classification is machine-checkable at onboarding time.
export const EXITED = ["bea", "glc"];

// PURE - unit-tested. Raw 7-dp i128 strings in, verdict out.
export function assess(supplyRaw, contributedRaw, thresholdUsd = DRIFT_THRESHOLD_USD) {
  const supply = Number(BigInt(supplyRaw ?? 0)) / 1e7;
  const contributed = Number(BigInt(contributedRaw ?? 0)) / 1e7;
  const drift = supply - contributed;
  if (drift >= thresholdUsd) return { state: "UNDER", supply, contributed, drift };
  // Contributed ABOVE supply is not "fine" - it means the books claim more capital
  // than shares exist. Never seen; if it happens someone should look immediately.
  if (drift <= -thresholdUsd) return { state: "OVER", supply, contributed, drift };
  return { state: "OK", supply, contributed, drift };
}

const usd = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * @param {object} o
 * @param {object} o.rpc         config.rpc
 * @param {object} o.admin       Keypair (read source only - nothing is signed)
 * @param {string} o.passphrase
 * @param {number} o.threshold
 * @param {Array}  o.tracked
 * @returns {Promise<{report: Array, drifted: Array}>}
 */
export async function checkCapitalDrift({ rpc, admin, passphrase, threshold = DRIFT_THRESHOLD_USD, tracked = TRACKED }) {
  const read = async (cid, fn) => {
    const acct = new Account(admin.publicKey(), "0");
    const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: passphrase })
      .addOperation(new Contract(cid).call(fn)).setTimeout(30).build();
    const sim = await rpc.simulateTransaction(tx);
    if (sim.error) throw new Error(`${fn} @ ${cid.slice(0, 8)}: ${String(sim.error).slice(0, 120)}`);
    return sim.result?.retval !== undefined ? scValToNative(sim.result.retval) : 0n;
  };

  const report = [], drifted = [];
  for (const t of tracked) {
    try {
      const [supplyRaw, contributedRaw] = await Promise.all([
        read(t.token, "total_supply"),
        read(t.dist, "contributed_capital"),
      ]);
      const a = assess(String(supplyRaw), String(contributedRaw), threshold);
      const row = { ...t, ...a };
      report.push(row);
      if (a.state === "OK") {
        console.log(`  ok    ${t.key.padEnd(6)} basis ${usd(a.contributed).padStart(14)} == supply`);
      } else {
        drifted.push(row);
        console.error(`  ${a.state === "OVER" ? "!!!!" : "DRIFT"} ${t.key.padEnd(6)} basis ${usd(a.contributed).padStart(14)} vs supply ${usd(a.supply).padStart(14)}  gap ${usd(a.drift)}  -> ${t.truer}`);
        if (a.state === "OVER") console.error(`       OVER = off-par signal: if this offering has >1 holder, the next distribution's ROC leg misattributes per holder (bd osre-2lw, osre-per-holder-attribution-design.md) - read share_price + check for burns before acting.`);
      }
    } catch (e) {
      // A cold/archived contract throws here; the warm pass fixes that, and this
      // must not take the cron down.
      console.error(`  ERROR ${t.key.padEnd(6)} ${String(e?.message ?? e).slice(0, 140)}`);
      report.push({ ...t, state: "ERROR", error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { report, drifted };
}

// Ops rail only: the sponsor DM, never the public channel (NOTES rails map).
// Returns { sent, reason }. A generic "log only" here would tell you to fix the
// thing you may have just fixed - name the actual cause. (2026-08-07)
export async function pingOps(drifted) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_OPS_ID;
  if (!drifted.length) return { sent: false, reason: "nothing to report" };
  if (!token) return { sent: false, reason: "TELEGRAM_BOT_TOKEN not set in .env - alert path is DEAD" };
  if (!chat) return { sent: false, reason: "TELEGRAM_OPS_ID not set in .env - alert path is DEAD" };
  const body = "CAPITAL BASE DRIFT\n"
    + drifted.map(d => `${d.key}: basis ${usd(d.contributed)} vs supply ${usd(d.supply)} (gap ${usd(d.drift)})`).join("\n")
    + "\n\nPref accrues on the BASIS, so the chain is under-recording what is owed."
    + "\nadd_capital accrues pref FIRST - the gap period is NOT back-paid. True it soon.";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: body }),
    });
    if (res.ok) return { sent: true, reason: "ops DM sent" };
    let why = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.description) why += ` - ${j.description}`; } catch { /* keep status */ }
    return { sent: false, reason: `Telegram REFUSED the send: ${why}` };
  } catch (e) {
    return { sent: false, reason: `Telegram unreachable: ${String(e?.message ?? e).slice(0, 90)}` };
  }
}

// --- standalone -----------------------------------------------------------
if (process.argv[1]?.endsWith("capital_drift.mjs")) {
  const { config } = await import("./lib/utils/env_config.js");
  console.log(`CAPITAL DRIFT ${new Date().toISOString()}`);
  const { drifted } = await checkCapitalDrift({ rpc: config.rpc, admin: config.admin, passphrase: config.passphrase });
  const r = await pingOps(drifted);
  console.log(`${drifted.length} drifted — ${r.reason}`);
  if (drifted.length) process.exit(1);
}
