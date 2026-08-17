// deploy_scale_factories.mjs - 10 wrapper-factories for the scale-cohort
// credit facilities (5 for OSREScaleEquity's solo properties, 5 for
// OSREScaleDebt's senior notes), same "self-servicing credit account"
// mechanism as the original two facilities. Mirrors deploy_note_factory.mjs
// exactly (same clone-wasm-from-an-existing-factory pattern, same
// initialize/set_wasm_hash sequence) -- looped over 10 (pool, collateral)
// pairs instead of hand-written once.
//
// Wrapper-factory wasm is generic across facilities (deploy_note_factory.mjs
// itself clones the EQUITY factory's wasm to build a DEBT-facility factory
// -- same bytecode, different init params), so any existing factory/wrapper
// pair is a valid clone source. Reserve indices read fresh from each pool's
// own get_reserve (never guessed) immediately before this script ran:
// USDC=0 in both pools; st06-10 = indices 1-5 in OSREScaleEquity;
// st01sr-05sr = indices 1-5 in OSREScaleDebt. Both pools confirmed status=0
// (Active) immediately before this script ran.
import * as SDK from '@stellar/stellar-sdk';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const { rpc, Keypair, TransactionBuilder, Contract, Address, nativeToScVal, scValToNative, xdr, Operation } = SDK;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASS = 'Test SDF Network ; September 2015';

const FACTORY_WASM_SRC = 'CD56PFRTBWHEBUHYLCJ46QB236LDZLDCKL2S2LZFHU6XP4SLKW2Q54SD'; // existing equity-facility factory
const WRAPPER_WASM_SRC = 'CDXB3B3BUTWWJLPH6ML7MVFDGXKGTX64J4FBGPT2SY6JQBSFLCLTGVDC'; // existing wrapper instance
const USDC = 'CDZRCVZLDCZ2MJAASY7ECKFE2KNGRWQFFZE3SESKFASLDTGWZZ6WWXRV';

const EQUITY_POOL = 'CB6ZOFIL7B3CCI6JANYHV7DR6HRXSZGN3RZ6SNMIUGOKQCL4DBBYU4HJ';
const DEBT_POOL = 'CA72WVM75GVXADBGAP4753EEJUN56PQX62VFU5NUOEOO6DMV6T7DBRN5';

// CORRECTED: the factory/wrapper's last init param is `usdc_index` -- USDC's
// OWN reserve index in the pool (verified against credit-wrapper/src/lib.rs:
// "UsdcIdx, // USDC's reserve index in the pool (0 in OSRECreditRWA)", used
// internally as pos.liabilities.get(idx) to find the wrapper's own debt).
// It is NOT the collateral asset's index. USDC is index 0 in BOTH scale-
// cohort pools (confirmed via a fresh get_reserve read). The first version
// of this script passed the collateral asset's index (1-5) into this slot
// by mistake -- caught by re-reading the actual factory/wrapper source
// AFTER the first (broken) deployment, not before. Those 10 factories are
// abandoned; this corrected run deploys 10 fresh ones with usdc_index=0
// for all of them, matching deploy_note_factory.mjs's own proven call
// (which hardcodes 0 in this exact slot).
const TARGETS = [
  { key: 'osreFactoryScaleSt06', pool: EQUITY_POOL, asset: 'CDFNNF3UVBUAIWXT4GJT3JJ6Y7LFDKF3JXT5C53GL6EMHEZBCC7JKUJW', usdcIdx: 0, label: 'st06' },
  { key: 'osreFactoryScaleSt07', pool: EQUITY_POOL, asset: 'CBSX3S2ATKGEACTRTEL2GMMPZXLKQDXC3DJIHFGIODBRJTDUD4YFVZGK', usdcIdx: 0, label: 'st07' },
  { key: 'osreFactoryScaleSt08', pool: EQUITY_POOL, asset: 'CBYE2HIPHKZ452HFYTARJKYAHKDSB2F2VUE6UGKRTDDI3ZYZUE6VJ3Z4', usdcIdx: 0, label: 'st08' },
  { key: 'osreFactoryScaleSt09', pool: EQUITY_POOL, asset: 'CCINKXBJKP37PRTT5RN4UGBKSTRD4MNWSSG2PIYQNFLUDQXFWUZ7RVIM', usdcIdx: 0, label: 'st09' },
  { key: 'osreFactoryScaleSt10', pool: EQUITY_POOL, asset: 'CBCQLPQY7P4LA7XXQLAL3KDFHYVBEKWT7HCQHM5MS7PRGXGIO2UM32YT', usdcIdx: 0, label: 'st10' },
  { key: 'osreFactoryScaleSt01sr', pool: DEBT_POOL, asset: 'CDERDNG4UL5GC3K3AZ6CLRABDTJRKH6DK5I2L7PJLYVWFGB46DRHDX74', usdcIdx: 0, label: 'st01sr' },
  { key: 'osreFactoryScaleSt02sr', pool: DEBT_POOL, asset: 'CB64NNJCBXJP4BKH2I7UPAFFUHDFLKUWY32UZEIFIWAYZ3JRXPVJ5EC6', usdcIdx: 0, label: 'st02sr' },
  { key: 'osreFactoryScaleSt03sr', pool: DEBT_POOL, asset: 'CBZ3HFT4NKYX24XR2EUMGZ6OQQORM66VL464SYEN456PNXPC2HJBNKUH', usdcIdx: 0, label: 'st03sr' },
  { key: 'osreFactoryScaleSt04sr', pool: DEBT_POOL, asset: 'CCT3ODBYPZNYFAWXSVGWONYJ5BKDU3MGXIK45QETP3ICUB2SYZLT7OOR', usdcIdx: 0, label: 'st04sr' },
  { key: 'osreFactoryScaleSt05sr', pool: DEBT_POOL, asset: 'CA7OJDQRRMTD7XG6PEBNI32SEMOAYP7NS3GYBT6QKXGEAYK4TG2I3E6A', usdcIdx: 0, label: 'st05sr' },
];

const server = new rpc.Server(RPC_URL);
const kp = Keypair.fromSecret(execSync('stellar keys show osre-deployer', { encoding: 'utf8' }).trim());

async function wasmHashOf(cid) {
  const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(cid).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  }));
  const e = await server.getLedgerEntries(k);
  return e.entries[0].val.contractData().val().instance().executable().wasmHash();
}
async function send(op, label) {
  const acct = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(acct, { fee: '10000000', networkPassphrase: PASS })
    .addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(label + ' sim: ' + sim.error.slice(0, 300));
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(label + ' submit failed');
  for (let i = 0; i < 30; i++) {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash: sent.hash } }) });
    const j = (await r.json()).result;
    if (j?.status && j.status !== 'NOT_FOUND') {
      console.log(`    ${label}: ${j.status}  tx ${sent.hash}`);
      if (j.status !== 'SUCCESS') throw new Error(label + ' ' + j.status);
      return j;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error(label + ' poll timeout');
}
async function read(cid, method, args = []) {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: PASS })
    .addOperation(new Contract(cid).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(method + ' sim: ' + sim.error.slice(0, 200));
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

const [facWasm, wrapWasm] = await Promise.all([wasmHashOf(FACTORY_WASM_SRC), wasmHashOf(WRAPPER_WASM_SRC)]);
console.log('factory wasm', facWasm.toString('hex').slice(0, 12) + '... | wrapper wasm', wrapWasm.toString('hex').slice(0, 12) + '...');
console.log('deployer/admin/servicer:', kp.publicKey());

const results = {};
for (const t of TARGETS) {
  console.log(`\n=== ${t.label} (${t.key}) — pool ${t.pool.slice(0, 8)}... usdcIdx=${t.usdcIdx} ===`);
  // deploy + construct in ONE atomic call (bd osre-6ve, 2026-08-17):
  // wrapper-factory's initialize() is now its __constructor -- this used to
  // be a separate step (a front-runnable gap in between); constructorArgs
  // on createCustomContract makes deploy+construct one atomic host call.
  const dep = await send(Operation.createCustomContract({
    address: new Address(kp.publicKey()), wasmHash: facWasm, salt: randomBytes(32),
    constructorArgs: [
      new Address(kp.publicKey()).toScVal(),   // admin
      new Address(kp.publicKey()).toScVal(),   // servicer
      new Address(t.pool).toScVal(),
      new Address(USDC).toScVal(),
      new Address(t.asset).toScVal(),
      nativeToScVal(t.usdcIdx, { type: 'u32' }),
    ],
  }), `${t.label} deploy+construct factory`);
  const meta = xdr.TransactionMeta.fromXDR(dep.resultMetaXdr, 'base64');
  const rv = meta.switch() === 4 ? meta.v4().sorobanMeta()?.returnValue() : meta.v3().sorobanMeta()?.returnValue();
  const FACTORY = Address.fromScVal(rv).toString();
  console.log(`    ${t.label} factory:`, FACTORY);

  const c = new Contract(FACTORY);
  await send(c.call('set_wasm_hash', nativeToScVal(wrapWasm, { type: 'bytes' })), `${t.label} arm wrapper wasm`);

  const sv = await read(FACTORY, 'servicer');
  const ok = String(sv) === kp.publicKey();
  console.log(`    servicer check: ${sv}  ${ok ? '(correct)' : '(UNEXPECTED)'}`);
  if (!ok) throw new Error(`${t.label}: servicer mismatch after init, stopping`);

  results[t.key] = FACTORY;
}

console.log('\n=== all 10 deployed ===');
console.log(JSON.stringify(results, null, 2));

const reg = JSON.parse(readFileSync('testnet.contracts.json', 'utf8').replace(/^﻿/, ''));
// Preserve the first (broken, usdc_index set to the collateral index
// instead of USDC's own index -- see the TARGETS comment above) deployment
// under a visibly-marked key rather than silently overwriting it, matching
// this repo's own correction-visibility convention. Do not reuse these.
if (reg.ids.osreFactoryScaleSt06 && !reg.ids._broken_2026_08_15_wrong_usdc_index) {
  reg.ids._broken_2026_08_15_wrong_usdc_index = {
    osreFactoryScaleSt06: reg.ids.osreFactoryScaleSt06, osreFactoryScaleSt07: reg.ids.osreFactoryScaleSt07,
    osreFactoryScaleSt08: reg.ids.osreFactoryScaleSt08, osreFactoryScaleSt09: reg.ids.osreFactoryScaleSt09,
    osreFactoryScaleSt10: reg.ids.osreFactoryScaleSt10, osreFactoryScaleSt01sr: reg.ids.osreFactoryScaleSt01sr,
    osreFactoryScaleSt02sr: reg.ids.osreFactoryScaleSt02sr, osreFactoryScaleSt03sr: reg.ids.osreFactoryScaleSt03sr,
    osreFactoryScaleSt04sr: reg.ids.osreFactoryScaleSt04sr, osreFactoryScaleSt05sr: reg.ids.osreFactoryScaleSt05sr,
  };
}
Object.assign(reg.ids, results);
writeFileSync('testnet.contracts.json', JSON.stringify(reg, null, 2));
console.log('\nregistry updated: testnet.contracts.json now has all 10 CORRECTED osreFactoryScale* entries.');
console.log('The first (broken) deployment is preserved under ids._broken_2026_08_15_wrong_usdc_index for the record -- do not use those addresses.');
console.log('NEXT: registry-clear each wrapper as investors create one (the doorbell handles it, same as today), UI routing in osre-credit.html/osre-admin.html.');
