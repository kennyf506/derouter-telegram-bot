const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Verified against DeRouter's public settlement feed and finalized transactions.
const PROGRAM = '6qFJXFPbmenYRDUuCUnQaHsZNio9WpbAKVMbszLdFwTn';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SETTLE = crypto.createHash('sha256').update('global:settle').digest().subarray(0, 8);
const FILE = path.join(__dirname, 'chain_state.json');

function readState() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return {};
        throw new Error('鏈上快取讀取失敗，已保留原檔，請檢查 chain_state.json');
    }
}
function writeState(state) {
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(`${FILE}.tmp`, FILE);
}
function decode58(value) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const c of value || '') {
        const digit = alphabet.indexOf(c);
        if (digit < 0) return Buffer.alloc(0);
        n = n * 58n + BigInt(digit);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Buffer.concat([Buffer.alloc((value?.match(/^1*/) || [''])[0].length), Buffer.from(hex, 'hex')]);
}

function settlementAmount(tx, wallet) {
    if (!tx?.meta || tx.meta.err) return 0n;
    const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    const destinations = new Set();
    for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
        if (balance.mint === USDC && balance.owner === wallet && balance.uiTokenAmount.decimals === 6) {
            destinations.add(keys[balance.accountIndex]);
        }
    }
    let total = 0n;
    for (const inner of tx.meta.innerInstructions || []) {
        const parent = tx.transaction.message.instructions[inner.index];
        if (parent?.programId !== PROGRAM || !decode58(parent.data).subarray(0, 8).equals(SETTLE)) continue;
        for (const ix of inner.instructions) {
            const { type, info } = ix.parsed || {};
            if (ix.programId !== TOKEN || !['transfer', 'transferChecked'].includes(type)
                || !destinations.has(info?.destination) || destinations.has(info.source)) continue;
            const raw = info.amount ?? info.tokenAmount?.amount;
            if (/^\d+$/.test(raw)) total += BigInt(raw);
        }
    }
    return total;
}

async function rpc(method, params) {
    const delay = 500 - (Date.now() - lastRpcAt);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    lastRpcAt = Date.now();
    const url = process.env.DEROUTER_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const { data } = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 10000 });
    if (data.error || !Object.hasOwn(data, 'result')) throw new Error(`Solana ${method} 查詢失敗`);
    return data.result;
}

let running;
let timer;
let started = false;
let backoff = 30000;
let lastRpcAt = 0;

function limitValue() {
    return Math.max(1, Math.min(100, Math.floor(Number(process.env.DEROUTER_CHAIN_MAX_TRANSACTIONS) || 10)));
}

function enqueue(state, list) {
    for (const item of list) {
        if (!item.err && !state.transactions[item.signature]) {
            state.pending[item.signature] = { time: item.blockTime };
        }
    }
}

async function discover(state) {
    let wallet = process.env.DEROUTER_WALLET?.trim() || state.wallet;
    if (!wallet) {
        const { data } = await axios.get('https://api.derouter.network/api/containers', {
            headers: { Authorization: `Bearer ${process.env.DEROUTER_MGMT_KEY}` }, timeout: 10000,
        });
        const wallets = [...new Set((data || []).map(c => c.wallet).filter(Boolean))];
        if (wallets.length !== 1) throw new Error('請在 .env 設定 DEROUTER_WALLET（接收收益的 Solana 錢包地址）');
        [wallet] = wallets;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error('DEROUTER_WALLET 不是有效 Solana 地址');
    if (state.wallet !== wallet) state = { wallet, transactions: {} };
    state.transactions ||= {};
    state.pending ||= {};
    state.addresses ||= {};
    writeState(state);
    if (!state.discoveredAt || Date.now() - Date.parse(state.discoveredAt) > 3600000) {
        const accounts = await rpc('getTokenAccountsByOwner', [wallet, { mint: USDC }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
        state.tokenAccounts = [...new Set([...(state.tokenAccounts || []), ...accounts.value.map(a => a.pubkey)])];
        state.discoveredAt = new Date().toISOString();
        writeState(state);
    }
    if (!state.tokenAccounts?.length) throw new Error('錢包尚無可查詢的 USDC 帳戶，無法確認歷史收益');
    return state;
}

async function scanChain() {
    let state = await discover(readState());
    const pageSize = 100;
    try {
        // Follow every new page until the previous head, without losing arrivals during backfill.
        for (const address of state.tokenAccounts) {
            const cursor = state.addresses[address] ||= {};
            const opts = { limit: pageSize, commitment: 'finalized' };
            if (cursor.head) opts.until = cursor.head;
            if (cursor.headBefore) opts.before = cursor.headBefore;
            const list = await rpc('getSignaturesForAddress', [address, opts]);
            enqueue(state, list);
            if (!cursor.headBefore) {
                cursor.nextHead = list[0]?.signature || cursor.head;
                cursor.headStartedAt = new Date().toISOString();
            }
            if (!cursor.initialized) {
                cursor.initialized = true;
                cursor.historyBefore = list.at(-1)?.signature;
                cursor.oldest = list.at(-1)?.blockTime ?? null;
                cursor.historyDone = list.length < pageSize;
                cursor.head = cursor.nextHead;
                cursor.headBefore = null;
                cursor.syncedAt = cursor.headStartedAt;
            } else if (list.length === pageSize) {
                cursor.headBefore = list.at(-1).signature;
            } else {
                cursor.head = cursor.nextHead;
                cursor.headBefore = null;
                cursor.syncedAt = cursor.headStartedAt;
            }
            writeState(state);
        }
        // Share the history budget across token accounts and avoid an unbounded queue.
        if (Object.keys(state.pending).length < pageSize * Math.max(2, state.tokenAccounts.length)) {
            const index = (state.historyIndex || 0) % state.tokenAccounts.length;
            const address = state.tokenAccounts[index];
            state.historyIndex = index + 1;
            const cursor = state.addresses[address];
            if (!cursor.historyDone && cursor.historyBefore) {
                const list = await rpc('getSignaturesForAddress', [address, {
                    limit: pageSize, before: cursor.historyBefore, commitment: 'finalized',
                }]);
                enqueue(state, list);
                if (list.length) {
                    cursor.historyBefore = list.at(-1).signature;
                    cursor.oldest = list.at(-1).blockTime ?? cursor.oldest;
                }
                cursor.historyDone = list.length < pageSize;
            }
            writeState(state);
        }
        // Alternate newest and oldest work so fresh receipts cannot starve historical jobs.
        const jobs = Object.entries(state.pending).sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
        for (let i = 0; i < limitValue() && jobs.length; i += 1) {
            const [signature] = state.takeOldest ? jobs.pop() : jobs.shift();
            const tx = await rpc('getTransaction', [signature, {
                encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized',
            }]);
            if (!tx || !Number.isFinite(tx.blockTime)) throw new Error('鏈上交易尚無完整資料，稍後重試');
            state.transactions[signature] = { time: tx.blockTime, amount: settlementAmount(tx, state.wallet).toString() };
            delete state.pending[signature];
            state.takeOldest = !state.takeOldest;
            state.updatedAt = new Date().toISOString();
            writeState(state); // Persist each completed job, including before a later RPC failure.
        }
        delete state.lastError;
        writeState(state);
        return summarize(state);
    } catch (error) {
        state.lastError = 'RPC 暫時不可達或限流，背景將自動重試';
        writeState(state);
        throw error;
    }
}

function summarize(state, now = new Date()) {
    const todayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) / 1000;
    const monday = new Date(todayStart * 1000);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const weekStart = monday.getTime() / 1000;
    const selected = Object.values(state.transactions || {});
    const cursors = (state.tokenAccounts || []).map(address => state.addresses?.[address]);
    const pending = Object.values(state.pending || {});
    const covered = since => !state.lastError && cursors.length > 0 && cursors.every(c => c?.initialized && !c.headBefore
        && Date.parse(c.syncedAt) >= now.getTime() - 120000
        && (c.historyDone || (c.oldest != null && c.oldest <= since)))
        && !pending.some(item => item.time == null || item.time >= since);
    const oldest = selected.length ? Math.min(...selected.map(t => t.time)) : now.getTime() / 1000;
    const sum = since => Number(selected.filter(t => t.time >= since).reduce((s, t) => s + BigInt(t.amount), 0n)) / 1e6;
    const syncing = !cursors.length || cursors.some(c => !c?.historyDone || c.headBefore) || pending.length > 0;
    return {
        today: sum(todayStart), week: sum(weekStart), scanned: sum(0), wallet: state.wallet,
        todayComplete: covered(todayStart), weekComplete: covered(weekStart),
        since: new Date(oldest * 1000).toISOString(), count: selected.length,
        weekStart: monday.toISOString().slice(0, 10), syncing, pending: pending.length,
        updatedAt: state.updatedAt, lastError: state.lastError,
        syncedAt: cursors.length && cursors.every(c => c?.syncedAt)
            ? cursors.map(c => c.syncedAt).sort()[0] : null,
    };
}

function syncChainOnce() {
    if (!running) running = scanChain().finally(() => { running = null; });
    return running;
}

function startChainSync() {
    if (started) return;
    started = true;
    const tick = async () => {
        try {
            await syncChainOnce();
            backoff = 30000;
        } catch (error) {
            console.error('[chain] 同步暫停，稍後重試:', error.message);
            backoff = Math.min(backoff * 2, 300000);
        }
        if (started) {
            timer = setTimeout(tick, backoff);
            timer.unref?.();
        }
    };
    timer = setTimeout(tick, 0);
    timer.unref?.();
}

function stopChainSync() {
    started = false;
    clearTimeout(timer);
}

async function fetchChainEarnings() {
    startChainSync();
    const state = readState();
    const wallet = process.env.DEROUTER_WALLET?.trim();
    // Never display the previous wallet's cached receipts after a configuration change.
    return summarize(wallet && state.wallet !== wallet ? {} : state);
}

function formatChainEarnings(data, automatic = false) {
    if (!data.count && !data.todayComplete) {
        return '⛓ <b>DeRouter 鏈上已結算收益</b>\n首次背景同步中，尚無完整快取，請稍後再查詢。\n/derouter auto｜/derouter api｜/derouter chain';
    }
    return [
        '⛓ <b>DeRouter 鏈上已結算收益</b>',
        automatic ? 'API 無法讀取，已切換 Solana 鏈上統計' : '資料來源：Solana（手動切換）',
        '',
        `📅 今日入帳${data.todayComplete ? '' : '（部分）'}：<b>${data.today.toFixed(6)} USDC</b>`,
        `🗓 本週入帳${data.weekComplete ? '' : '（部分）'}：<b>${data.week.toFixed(6)} USDC</b>`,
        `🔎 掃描入帳合計：${data.scanned.toFixed(6)} USDC（${data.count} 筆交易）`,
        `掃描範圍起點：${data.since.slice(0, 19).replace('T', ' ')} UTC`,
        `本週起點：${data.weekStart} 00:00 UTC（週一）`,
        `快取更新：${data.updatedAt || '尚未完成'}・新交易檢查：${data.syncedAt || '尚未完成'}`,
        data.syncing ? `🔄 背景補齊中，已發現待處理 ${data.pending} 筆交易` : '✅ 已補齊可取得的歷史，背景持續更新',
        ...(data.lastError ? [`⚠️ ${data.lastError}，目前顯示本機快取`] : []),
        '',
        '<i>只計已確認的 DeRouter USDC 結算；不含充值、一般轉帳與未結算收益。部分表示尚未掃描完整期間；不提供 API task 數或累計收益，亦不混入 API 收益紀錄。</i>',
        '/derouter auto｜/derouter api｜/derouter chain',
    ].join('\n');
}

module.exports = { fetchChainEarnings, formatChainEarnings, settlementAmount, startChainSync, stopChainSync, syncChainOnce };
