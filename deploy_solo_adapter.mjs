// deploy_solo_adapter.mjs - one link in the equity-shaped scale-cohort oracle
// chain: prices ONE solo scale-cohort property token locally at par ($1.00,
// same convention as HVP/KMC-SR), delegates all else to whatever HEAD is
// passed in. Every pointer ours. Signs credit-admin. Pattern cloned verbatim
// from deploy_note_adapter.mjs (the proven KMC-SR precedent).
//
// Usage: node deploy_solo_adapter.mjs <HEAD_ADAPTER> <TOKEN_ADDR> <LABEL>
import * as SDK from '@stellar/stellar-sdk';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const { rpc, Keypair, TransactionBuilder, Contract, Address, nativeToScVal, scValToNative, xdr, Operation } = SDK;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASS = 'Test SDF Network ; September 2015';
const USDC = 'CDZRCVZLDCZ2MJAASY7ECKFE2KNGRWQFFZE3SESKFASLDTGWZZ6WWXRV';

const [, , HEAD, TOKEN, LABEL] = process.argv;
if (!HEAD || !TOKEN || !LABEL) {
  console.error('Usage: node deploy_solo_adapter.mjs <HEAD_ADAPTER> <TOKEN_ADDR> <LABEL>');
  process.exit(1);
}

const server = new rpc.Server(RPC_URL);
const admin = Keypair.fromSecret(execSync('stellar keys show credit-admin', { encoding: 'utf8' }).trim());
const stellarAsset = (a) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(a).toScVal()]);

async function send(opOrTx, label) {
  const acct = await server.getAccount(admin.publicKey());
  let tx = new TransactionBuilder(acct, { fee: '10000000', networkPassphrase: PASS })
    .addOperation(opOrTx).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(label + ' sim: ' + sim.error.slice(0, 300));
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(admin);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(label + ' submit: ' + JSON.stringify(sent.errorResult));
  for (let i = 0; i < 30; i++) {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash: sent.hash } }) });
    const j = (await r.json()).result;
    if (j?.status && j.status !== 'NOT_FOUND') {
      console.log(`  ${label}: ${j.status}  tx ${sent.hash}`);
      if (j.status !== 'SUCCESS') throw new Error(label + ' ' + j.status);
      return j;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error(label + ' poll timeout');
}
async function read(cid, method, args = []) {
  const acct = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: PASS })
    .addOperation(new Contract(cid).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(method + ' sim: ' + sim.error.slice(0, 200));
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

// 1) wasm hash + params from the live head (same wasm as every prior adapter)
const ikey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: new Address(HEAD).toScAddress(),
  key: xdr.ScVal.scvLedgerKeyContractInstance(),
  durability: xdr.ContractDataDurability.persistent(),
}));
const inst = (await server.getLedgerEntries(ikey)).entries[0].val.contractData().val().instance();
const wasmHash = inst.executable().wasmHash();
console.log(LABEL, '- adapter wasm:', wasmHash.toString('hex'));
const [staleness, clamp] = await Promise.all([read(HEAD, 'max_staleness'), read(HEAD, 'max_change_bps')]);
console.log('cloning params: max_staleness', String(staleness), '| max_change_bps', String(clamp));

// 2) deploy + construct in ONE atomic call (bd osre-6ve.7, 2026-08-17):
// initialize() is now oracle-adapter's __constructor. This used to be a
// SEPARATE step (deploy, then a later `c.call('initialize', ...)`) --
// anyone could front-run the gap between them and become admin before this
// script's own call landed. constructorArgs on createCustomContract makes
// deploy+construct one atomic host call, closing that window structurally
// (same fix as deploy_property.ps1's `-- --arg value` CLI equivalent).
const dep = await send(Operation.createCustomContract({
  address: new Address(admin.publicKey()), wasmHash, salt: randomBytes(32),
  constructorArgs: [
    new Address(admin.publicKey()).toScVal(),
    new Address(HEAD).toScVal(),
    new Address(TOKEN).toScVal(),
    nativeToScVal(BigInt(staleness), { type: 'u64' }),
  ],
}), 'deploy+construct ' + LABEL + ' adapter');
let newAdapter = null;
try { newAdapter = scValToNative(xdr.ScVal.fromXDR(dep.returnValue, 'base64')); } catch { /* fall through */ }
if (!newAdapter) {
  const meta = xdr.TransactionMeta.fromXDR(dep.resultMetaXdr, 'base64');
  const rv = meta.switch() === 4 ? meta.v4().sorobanMeta()?.returnValue() : meta.v3().sorobanMeta()?.returnValue();
  newAdapter = Address.fromScVal(rv).toString();
}
console.log(LABEL, 'ADAPTER:', newAdapter);

const c = new Contract(newAdapter);
await send(c.call('set_max_change_bps', nativeToScVal(Number(clamp), { type: 'u32' })), 'set clamp ' + LABEL);
await send(c.call('set_glc_price', nativeToScVal(10000000n, { type: 'i128' })), 'set par price ' + LABEL);

// 4) end-to-end probes: the new asset AND USDC (delegated through the whole chain)
const p1 = await read(newAdapter, 'lastprice', [stellarAsset(TOKEN)]);
const p2 = await read(newAdapter, 'lastprice', [stellarAsset(USDC)]);
console.log(LABEL, 'via new adapter:', p1 ? '$' + (Number(p1.price) / 1e7).toFixed(4) : 'NONE');
console.log('OSREUSDC via delegation chain:', p2 ? '$' + (Number(p2.price) / 1e7).toFixed(4) : 'NONE');
console.log((p1 && Number(p1.price) === 10000000 && p2) ? 'CHAIN LINK READY - ' + LABEL + ' adapter = ' + newAdapter : 'CHECK OUTPUT');
