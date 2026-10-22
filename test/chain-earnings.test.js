const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { settlementAmount } = require('../chain-earnings');

const PROGRAM = '6qFJXFPbmenYRDUuCUnQaHsZNio9WpbAKVMbszLdFwTn';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WALLET = '11111111111111111111111111111111';

function transaction() {
    return {
        blockTime: Math.floor(Date.now() / 1000),
        transaction: { message: {
            accountKeys: [{ pubkey: 'destination' }],
            // Real public Settle instruction data; only the Anchor discriminator is used.
            instructions: [{ programId: PROGRAM, data: 'NdZWiMZKGakDmmv5xxHwCT' }],
        } },
        meta: {
            err: null,
            postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: WALLET, uiTokenAmount: { decimals: 6 } }],
            innerInstructions: [{ index: 0, instructions: [{
                programId: TOKEN, parsed: { type: 'transfer', info: { source: 'escrow', destination: 'destination', amount: '1234567' } },
            }] }],
        },
    };
}

function loadChain(handler, max = 10, initial = {}) {
    let saved = initial;
    const writes = [];
    const sandbox = {
        module: { exports: {} }, Buffer, console,
        setTimeout: (fn, delay) => { if (delay > 0 && delay <= 500) queueMicrotask(fn); return { unref() {} }; },
        clearTimeout() {},
        process: { env: { DEROUTER_WALLET: WALLET, DEROUTER_CHAIN_MAX_TRANSACTIONS: String(max) } },
        __dirname: path.resolve(__dirname, '..'),
        require: name => {
            if (name === 'axios') return { post: async (url, body) => ({ data: { result: await handler(body.method, body.params) } }) };
            if (name === 'fs') return {
                readFileSync: () => JSON.stringify(saved),
                writeFileSync: (file, data) => { saved = JSON.parse(data); writes.push(file); },
                renameSync: (from, to) => writes.push(to),
            };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../chain-earnings.js'), 'utf8'), sandbox);
    return { ...sandbox.module.exports, writes, saved: () => JSON.parse(JSON.stringify(saved)) };
}

test('counts only finalized successful DeRouter USDC settlement receipts', () => {
    assert.equal(settlementAmount(transaction(), WALLET), 1234567n);
    const changes = [
        tx => { tx.meta.err = { InstructionError: [0, 'failed'] }; },
        tx => { tx.transaction.message.instructions[0].programId = 'other'; },
        tx => { tx.transaction.message.instructions[0].data = 'invalid'; },
        tx => { tx.meta.postTokenBalances[0].mint = 'other-mint'; },
        tx => { tx.meta.postTokenBalances[0].owner = 'other-wallet'; },
        tx => { tx.meta.innerInstructions[0].instructions[0].parsed.info.source = 'destination'; },
    ];
    for (const change of changes) {
        const tx = transaction(); change(tx);
        assert.equal(settlementAmount(tx, WALLET), 0n);
    }
});

test('discovers USDC accounts, scans receipts, caches transactions and keeps API logs separate', async () => {
    let reads = 0;
    const chain = loadChain((method, params) => {
        if (method === 'getTokenAccountsByOwner') return { value: [{ pubkey: 'ata' }] };
        if (method === 'getSignaturesForAddress') return [{ signature: 'one', err: null, blockTime: transaction().blockTime }];
        assert.equal(method, 'getTransaction');
        assert.equal(params[1].commitment, 'finalized');
        reads += 1;
        return transaction();
    });
    await chain.syncChainOnce();
    const result = await chain.fetchChainEarnings();
    assert.equal(result.today, 1.234567);
    assert.equal(result.week, 1.234567);
    assert.equal(result.todayComplete, true);
    await chain.fetchChainEarnings();
    assert.equal(reads, 1);
    assert.ok(chain.writes.every(file => /chain_state.json(?:\.tmp)?$/.test(file)));
});

test('capped scans are visibly partial rather than presented as lifetime totals', async () => {
    const chain = loadChain(method => {
        if (method === 'getTokenAccountsByOwner') return { value: [{ pubkey: 'ata' }] };
        if (method === 'getSignaturesForAddress') return ['one', 'two'].map(signature => ({ signature, err: null, blockTime: transaction().blockTime }));
        return transaction();
    }, 1);
    await chain.syncChainOnce();
    const result = await chain.fetchChainEarnings();
    assert.equal(result.todayComplete, false);
    assert.equal(result.weekComplete, false);
    const text = chain.formatChainEarnings(result, true);
    assert.match(text, /API 無法讀取/);
    assert.match(text, /今日入帳（部分）/);
    assert.match(text, /本週入帳（部分）/);
    assert.doesNotMatch(text, /累計 AllTime/);
});

test('RPC failure does not manufacture zero earnings', async () => {
    const chain = loadChain(() => { throw new Error('RPC offline'); });
    await assert.rejects(chain.syncChainOnce(), /RPC offline/);
    assert.match(chain.formatChainEarnings(await chain.fetchChainEarnings()), /首次背景同步中/);
});

test('history cursors and queued work survive restart; newest and oldest jobs both progress', async () => {
    const fetched = [];
    const recent = Array.from({ length: 100 }, (_, i) => ({ signature: `sig${i}`, blockTime: transaction().blockTime - i, err: null }));
    const older = [100, 101].map(i => ({ signature: `sig${i}`, blockTime: transaction().blockTime - i, err: null }));
    const handler = (method, params) => {
        if (method === 'getTokenAccountsByOwner') return { value: [{ pubkey: 'ata' }] };
        if (method === 'getSignaturesForAddress') {
            if (params[1].before === 'sig99') return older;
            if (params[1].until) return [];
            return recent;
        }
        fetched.push(params[0]);
        return transaction();
    };
    const chain = loadChain(handler, 1);
    await chain.syncChainOnce();
    assert.equal(chain.saved().addresses.ata.historyDone, true);
    assert.equal(Object.keys(chain.saved().pending).length, 101);
    const restarted = loadChain(handler, 1, chain.saved());
    await restarted.syncChainOnce();
    assert.deepEqual(fetched, ['sig0', 'sig101']);
    assert.equal(Object.keys(restarted.saved().transactions).length, 2);
    assert.equal((await restarted.fetchChainEarnings()).scanned, 2.469134);
    assert.equal(Object.keys(restarted.saved().pending).length, 100);
});

test('cache reads do not call RPC and retain data while the next job fails', async () => {
    const initial = {
        wallet: WALLET, tokenAccounts: ['ata'], discoveredAt: new Date().toISOString(),
        transactions: { cached: { time: transaction().blockTime, amount: '1234567' } },
        pending: { next: { time: transaction().blockTime } },
        addresses: { ata: { initialized: true, head: 'cached', historyDone: true, syncedAt: new Date().toISOString() } },
    };
    let calls = 0;
    const chain = loadChain(() => { calls += 1; throw new Error('rate limited'); }, 1, initial);
    assert.equal((await chain.fetchChainEarnings()).scanned, 1.234567);
    assert.equal(calls, 0);
    await assert.rejects(chain.syncChainOnce(), /rate limited/);
    assert.equal((await chain.fetchChainEarnings()).scanned, 1.234567);
    assert.equal(Object.keys(chain.saved().pending).length, 1);
    assert.ok(chain.saved().lastError);
});

test('stale snapshots retain totals but do not claim complete current-day coverage', async () => {
    const chain = loadChain(() => { throw new Error('cache read must not use RPC'); }, 1, {
        wallet: WALLET, tokenAccounts: ['ata'],
        transactions: { old: { time: transaction().blockTime, amount: '1234567' } },
        addresses: { ata: { initialized: true, historyDone: true, syncedAt: '2020-01-01T00:00:00Z' } },
    });
    const snapshot = await chain.fetchChainEarnings();
    assert.equal(snapshot.scanned, 1.234567);
    assert.equal(snapshot.todayComplete, false);
    assert.equal(snapshot.weekComplete, false);
});
