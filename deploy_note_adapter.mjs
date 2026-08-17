// deploy_note_adapter.mjs - new v2 adapter instance for the Note Credit pool:
// prices OSRE-KMC-SR locally at par (egress clamp inherited), delegates all
// else to the existing USD adapter. Every pointer ours. Signs credit-admin.
import * as SDK from '@stellar/stellar-sdk';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const { rpc, Keypair, TransactionBuilder, Contract, Address, nativeToScVal, scValToNative, xdr, Operation, StrKey } = SDK;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASS = 'Test SDF Network ; September 2015';
const HEAD = 'CDP6FKQU2WJIHHCSHUYWHLLVFQE3WGRF2OT4SO23WC4LD23PD2A6TSC7'; // v2 adapter to clone + delegate target
const KMCSR = 'CBFHGHCKUQU7ELKNFCWFWYFHH3UD4S5DLM7OUWYFKN742QOBRZRVWXZL';
const USDC = 'CDZRCVZLDCZ2MJAASY7ECKFE2KNGRWQFFZE3SESKFASLDTGWZZ6WWXRV';
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

// 1) wasm hash + params from the live head
const ikey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: new Address(HEAD).toScAddress(),
  key: xdr.ScVal.scvLedgerKeyContractInstance(),
  durability: xdr.ContractDataDurability.persistent(),
}));
const inst = (await server.getLedgerEntries(ikey)).entries[0].val.contractData().val().instance();
const wasmHash = inst.executable().wasmHash();
console.log('v2 adapter wasm:', wasmHash.toString('hex'));
const [staleness, clamp] = await Promise.all([read(HEAD, 'max_staleness'), read(HEAD, 'max_change_bps')]);
console.log('cloning params: max_staleness', String(staleness), '| max_change_bps', String(clamp));

// 2) deploy + construct in ONE atomic call (bd osre-6ve.7, 2026-08-17):
// initialize() is now oracle-adapter's __constructor -- deploy+construct
// used to be two separate steps (a front-runnable gap in between);
// constructorArgs on createCustomContract makes it one atomic host call.
const dep = await send(Operation.createCustomContract({
  address: new Address(admin.publicKey()), wasmHash, salt: randomBytes(32),
  constructorArgs: [
    new Address(admin.publicKey()).toScVal(),
    new Address(HEAD).toScVal(),
    new Address(KMCSR).toScVal(),
    nativeToScVal(BigInt(staleness), { type: 'u64' }),
  ],
}), 'deploy+construct adapter');
const retvalXdr = dep.returnValue ?? dep.resultMetaXdr;
let noteAdapter = null;
try { noteAdapter = scValToNative(xdr.ScVal.fromXDR(dep.returnValue, 'base64')); } catch { /* fall through */ }
if (!noteAdapter) {
  const meta = xdr.TransactionMeta.fromXDR(dep.resultMetaXdr, 'base64');
  const rv = meta.v3().sorobanMeta().returnValue();
  noteAdapter = Address.fromScVal(rv).toString();
}
console.log('NOTE ADAPTER:', noteAdapter);

const c = new Contract(noteAdapter);
await send(c.call('set_max_change_bps', nativeToScVal(Number(clamp), { type: 'u32' })), 'set clamp');
await send(c.call('set_glc_price', nativeToScVal(10000000n, { type: 'i128' })), 'set par price');

// 4) end-to-end probes: both pool-2 assets through the new head
const p1 = await read(noteAdapter, 'lastprice', [stellarAsset(KMCSR)]);
const p2 = await read(noteAdapter, 'lastprice', [stellarAsset(USDC)]);
console.log('KMC-SR via note adapter:', p1 ? '$' + (Number(p1.price) / 1e7).toFixed(4) : 'NONE');
console.log('OSREUSDC via delegation:', p2 ? '$' + (Number(p2.price) / 1e7).toFixed(4) : 'NONE');
console.log((p1 && Number(p1.price) === 10000000 && p2) ? 'ORACLE STACK READY - add to registry: osreAdapterNote = ' + noteAdapter : 'CHECK OUTPUT');