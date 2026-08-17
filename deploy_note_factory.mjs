// deploy_note_factory.mjs - factory 3: self-servicing credit accounts for the
// Debt Credit Facility. Wasm hashes read live from factory 2 + GDSL's wrapper.
import * as SDK from '@stellar/stellar-sdk';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const { rpc, Keypair, TransactionBuilder, Contract, Address, nativeToScVal, scValToNative, xdr, Operation } = SDK;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASS = 'Test SDF Network ; September 2015';
const FACTORY2 = 'CD56PFRTBWHEBUHYLCJ46QB236LDZLDCKL2S2LZFHU6XP4SLKW2Q54SD';
const GDSL_WRAP = 'CDXB3B3BUTWWJLPH6ML7MVFDGXKGTX64J4FBGPT2SY6JQBSFLCLTGVDC';
const NOTE_POOL = 'CDCZGPMNHRNB3WLMB23KFJB4RRXWAAY3JOAMT3XFVHGM5RPUPMU44OJI';
const USDC = 'CDZRCVZLDCZ2MJAASY7ECKFE2KNGRWQFFZE3SESKFASLDTGWZZ6WWXRV';
const KMCSR = 'CBFHGHCKUQU7ELKNFCWFWYFHH3UD4S5DLM7OUWYFKN742QOBRZRVWXZL';
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
      console.log(`  ${label}: ${j.status}  tx ${sent.hash}`);
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

const [facWasm, wrapWasm] = await Promise.all([wasmHashOf(FACTORY2), wasmHashOf(GDSL_WRAP)]);
console.log('factory wasm', facWasm.toString('hex').slice(0, 12) + '... | wrapper wasm', wrapWasm.toString('hex').slice(0, 12) + '...');

// deploy + construct in ONE atomic call (bd osre-6ve, 2026-08-17):
// wrapper-factory's initialize() is now its __constructor -- this used to
// be a separate step (a front-runnable gap in between); constructorArgs on
// createCustomContract makes deploy+construct one atomic host call.
const dep = await send(Operation.createCustomContract({
  address: new Address(kp.publicKey()), wasmHash: facWasm, salt: randomBytes(32),
  constructorArgs: [
    new Address(kp.publicKey()).toScVal(),   // admin
    new Address(kp.publicKey()).toScVal(),   // servicer = the coupon payer's identity
    new Address(NOTE_POOL).toScVal(),
    new Address(USDC).toScVal(),
    new Address(KMCSR).toScVal(),
    nativeToScVal(0, { type: 'u32' }),
  ],
}), 'deploy+construct factory 3');
const meta = xdr.TransactionMeta.fromXDR(dep.resultMetaXdr, 'base64');
const rv = meta.switch() === 4 ? meta.v4().sorobanMeta()?.returnValue() : meta.v3().sorobanMeta()?.returnValue();
const FACTORY3 = Address.fromScVal(rv).toString();
console.log('FACTORY 3:', FACTORY3);

const c = new Contract(FACTORY3);
await send(c.call('set_wasm_hash', nativeToScVal(wrapWasm, { type: 'bytes' })), 'arm wrapper wasm');
const sv = await read(FACTORY3, 'servicer');
console.log('servicer:', String(sv), String(sv) === kp.publicKey() ? '(= osre-deployer, correct)' : '(UNEXPECTED)');

const reg = JSON.parse(readFileSync('testnet.contracts.json', 'utf8').replace(/^\uFEFF/, ''));
reg.ids.osreFactoryNote = FACTORY3;
writeFileSync('testnet.contracts.json', JSON.stringify(reg, null, 2));
console.log('registry: osreFactoryNote recorded. NEXT: registry-clear each created wrapper (the doorbell handles it), UI un-gate, coupon routing.');