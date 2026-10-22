// ==========================================
// 🔧 DeRouter 自動調速模組
// ------------------------------------------
// 依時間相位與當日收益，自動調整各帳號的 dispatch_mode。
//
// 規格（預設值，可用 .env 覆寫）：
//   rapidhusky344@yourmon.com：台北 08:00 → speed_5x；當日收益達 $14 → speed_2x；台北 00:00 → normal
//   kennyf5056@gmail.com：台北 08:00 → speed_2x；台北 00:00 → normal
//
// 說明：
//   - 「當日收益」用的是 /api/billing/earnings 的 today（整個容器當日總收益，
//     以 UTC 換日＝台北早上 8 點歸零），跟每日報告同一個口徑。
//   - 帳號 accountId 可能因為移除再加而改變，所以每次都用 email 即時查出當下 ID，
//     不寫死 ID，較穩。
//   - 每個動作每日只做一次（用台北日期當旗標），重啟後不會重複；且啟動時會依
//     當下時間自動補到正確相位。
//   - dispatch_mode 可用值：humanlike / normal / speed_2x / speed_3x / speed_5x
//     （注意：寫入欄位是底線 dispatch_mode，讀回來時欄位叫 dispatchMode）
//
// 需要 .env：
//   DEROUTER_MGMT_KEY        = management key（與收益模組共用）
//   DEROUTER_CHAT_ID         = 接收調速通知的 Telegram ID
//   DISPATCH_c20x_EMAIL      = （選填）預設 rapidhusky344@yourmon.com
//   DISPATCH_KENNY_EMAIL     = （選填）預設 kennyf5056@gmail.com
//   DISPATCH_c20x_THRESHOLD  = （選填）c20x 當日降速門檻美元，預設 14
//   DISPATCH_ENABLED         = （選填）設 false 可暫停自動調速（仍保留 /speed 手動指令）
// ==========================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { calculateMonthlyCost, formatMonthlyCost } = require('./costs');
const { fetchEarnings } = require('./earnings-api');

const API_BASE = 'https://api.derouter.network/api';
const CONTAINERS_URL = `${API_BASE}/containers`;
const STATE_FILE = path.join(__dirname, 'dispatch_state.json');
const TZ = 'Asia/Taipei';

const TICK_MS = 60 * 1000;       // 每分鐘檢查時間相位
const EARN_MS = 5 * 60 * 1000;   // 每 5 分鐘檢查當日收益門檻
const MORNING_HOUR = 8;          // 台北 08:00＝UTC 換日、當日收益歸零時刻

const VALID_MODES = ['humanlike', 'normal', 'speed_2x', 'speed_3x', 'speed_5x'];
const c20x_EMAIL = process.env.DISPATCH_c20x_EMAIL || 'rapidhusky344@yourmon.com';
const KENNY_EMAIL = process.env.DISPATCH_KENNY_EMAIL || 'kennyf5056@gmail.com';
const c20x_THRESHOLD = Number(process.env.DISPATCH_c20x_THRESHOLD) || 14;
const ENABLED = String(process.env.DISPATCH_ENABLED || 'true').toLowerCase() !== 'false';

// ---- 狀態持久化（記錄各動作最後執行的台北日期，避免重複）----
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error('[dispatch] 無法寫入狀態檔:', e.message); }
}

// ---- API ----
function authHeader() {
    const key = process.env.DEROUTER_MGMT_KEY;
    if (!key) throw new Error('缺少 DEROUTER_MGMT_KEY 環境變數');
    return { Authorization: `Bearer ${key}` };
}
async function fetchContainers() {
    const res = await axios.get(CONTAINERS_URL, { headers: authHeader(), timeout: 15000 });
    return res.data;
}
async function fetchToday() {
    const data = await fetchEarnings();
    return Number(data.today);
}
// 用 email 從容器清單找出帳號當下的 containerId / accountId / 現在的模式
function findAccount(containers, email) {
    for (const c of containers || []) {
        for (const a of (c.accounts || [])) {
            if (a.email === email) {
                return { containerId: c.id, accountId: a.id, mode: a.dispatchMode };
            }
        }
    }
    return null;
}
async function setDispatch(containerId, accountId, mode) {
    await axios.patch(
        `${CONTAINERS_URL}/${containerId}/accounts/${accountId}`,
        { dispatch_mode: mode },
        { headers: { ...authHeader(), 'Content-Type': 'application/json' }, timeout: 15000 }
    );
}
// 啟動 / 暫停帳號（帳號層級，與儀表板帳號列的 stop/restart 按鈕相同：
// restart＝啟動、stop＝暫停）。務必 POST 不帶 body、不帶 Content-Type——
// 之前帶 `{}` body 時 stop 後容器曾進 error，改為與網頁請求完全一致。
async function setStatus(containerId, accountId, status) {
    const action = status === 'running' ? 'restart' : 'stop';
    await axios.post(
        `${CONTAINERS_URL}/${containerId}/accounts/${accountId}/${action}`,
        undefined,
        { headers: authHeader(), timeout: 60000 }
    );
}
// 列出所有容器裡的所有帳號（附 containerId），給動態選單用
function listAccounts(containers) {
    const out = [];
    for (const c of containers || []) {
        for (const a of (c.accounts || [])) {
            out.push({ containerId: c.id, accountId: a.id, email: a.email, mode: a.dispatchMode, status: a.status, containerStatus: c.status, containerError: c.error_message, banned: a.banned, expired: a.expired });
        }
    }
    return out;
}
// callback_data 放不下完整 UUID，用 accountId 前 8 碼即時比對（每次都查最新清單）
function findByIdPrefix(containers, prefix) {
    return listAccounts(containers).find((a) => a.accountId.startsWith(prefix)) || null;
}
function statusLabel(a) {
    if (a.banned) return '🚫 被封鎖';
    if (a.expired) return '⌛ 已過期';
    if (a.containerStatus === 'error') return '⚠️ 容器錯誤';
    // 帳號運作中的值是 'active'（'running' 是容器層級的值）；容器沒在跑就不算運作中
    return (a.containerStatus === 'running' && a.status === 'active') ? '▶️ 運作中' : '⏸ 已暫停';
}
// 某容器的各帳號額度（5 小時／週剩餘百分比、重置時間等）
async function fetchBudgets(containerId) {
    const res = await axios.get(`${CONTAINERS_URL}/${containerId}/budget`, { headers: authHeader(), timeout: 15000 });
    return Array.isArray(res.data) ? res.data : [];
}

// 指令用的短代號 → email
const WHO_EMAIL = { c20x: c20x_EMAIL, kenny: KENNY_EMAIL };
// dispatch_mode → 顯示名稱
function modeLabel(m) {
    return { humanlike: 'Human-like', normal: 'Normal', speed_2x: 'Speed 2x', speed_3x: 'Speed 3x', speed_5x: 'Speed 5x' }[m] || m || '未知';
}
// UTC ISO 時間 → 台北 MM/DD HH:mm
function fmtTaipei(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
}

function quotaPlanLabel(account, budget) {
    const plan = account.plan || budget?.plan || '未知方案';
    if (plan !== 'team') return plan;
    const tiers = {
        team_standard: 'Standard',
        team_tier_1: 'Premium',
        team_premium: 'Premium',
    };
    return `Team ${tiers[account.seatTier] || `（席位未識別：${account.seatTier || '未知'}）`}`;
}

function quotaRemainingLabel(value) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
    const pct = Number(value);
    const emoji = pct <= 0 ? '🔴' : pct <= 5 ? '🟠' : pct >= 80 ? '🧊' : '';
    return `${emoji}${pct}%`;
}

function quotaResetTime(value) {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : Infinity;
}

// ---- 台北現在的日期與小時 ----
function taipeiNow() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: parseInt(get('hour'), 10),
    };
}

// ==========================================
// 主啟動函式
// ==========================================
function initDispatch(bot) {
    if (!process.env.DEROUTER_MGMT_KEY || !process.env.DEROUTER_CHAT_ID) {
        console.warn('[dispatch] 未設定 DEROUTER_MGMT_KEY 或 DEROUTER_CHAT_ID，調速模組略過啟動');
        return;
    }
    const CHAT_ID = process.env.DEROUTER_CHAT_ID;
    const OWNER_ID = Number(CHAT_ID);
    let state = loadState();
    const notify = (t) => bot.sendMessage(CHAT_ID, t).catch((e) => console.error('[dispatch] 通知失敗:', e.message));

    // 依 email 設定模式；回傳實際採用的模式，找不到或已是目標則不重複打
    async function applyMode(email, mode) {
        const containers = await fetchContainers();
        const acc = findAccount(containers, email);
        if (!acc) { notify(`自動調速：找不到帳號 ${email}，本次略過`); return null; }
        if (acc.mode === mode) return mode; // 已是目標模式，省一次寫入
        await setDispatch(acc.containerId, acc.accountId, mode);
        return mode;
    }

    // ---- 每分鐘：依台北時間切換日/夜相位（每相位每日一次，重啟自動補位）----
    // 相位A 00:00–07:59 → 兩帳號 normal（休息回血）
    // 相位B 08:00–23:59 → c20x speed_5x、kenny speed_2x
    async function scheduleTick() {
        if (!ENABLED) return;
        try {
            const { date, hour } = taipeiNow();
            if (hour < MORNING_HOUR) {
                if (state.nightDate !== date) {
                    await applyMode(c20x_EMAIL, 'normal');
                    await applyMode(KENNY_EMAIL, 'normal');
                    state.nightDate = date;
                    saveState(state);
                    notify('自動調速（夜間標準）：c20x → normal、kenny → normal');
                }
            } else {
                if (state.morningDate !== date) {
                    await applyMode(c20x_EMAIL, 'speed_5x');
                    await applyMode(KENNY_EMAIL, 'speed_2x');
                    state.morningDate = date;
                    state.c20xDownDate = null; // 新的一天，重置「已因門檻降速」旗標
                    saveState(state);
                    notify('自動調速（日間衝量）：c20x → speed_5x、kenny → speed_2x');
                }
            }
        } catch (e) {
            console.error('[dispatch] 相位排程失敗:', e.message);
        }
    }

    // ---- 每 5 分鐘：c20x 當日收益達門檻 → 降 speed_2x（僅日間、僅目前為 5x、每日一次）----
    async function thresholdTick() {
        if (!ENABLED) return;
        try {
            const { date, hour } = taipeiNow();
            if (hour < MORNING_HOUR) return;         // 夜間相位不套用
            if (state.c20xDownDate === date) return;  // 今天已降過
            const today = await fetchToday();
            if (today < c20x_THRESHOLD) return;
            const containers = await fetchContainers();
            const acc = findAccount(containers, c20x_EMAIL);
            if (!acc) return;
            if (acc.mode !== 'speed_5x') return;      // 只在早上設定的 5x 狀態才降，避免蓋掉手動/夜間
            await setDispatch(acc.containerId, acc.accountId, 'speed_2x');
            state.c20xDownDate = date;
            saveState(state);
            notify(`自動調速：c20x 當日收益達 $${today.toFixed(2)}（≥ $${c20x_THRESHOLD}）→ speed_2x`);
        } catch (e) {
            console.error('[dispatch] 門檻檢查失敗:', e.message);
        }
    }

    // ---- 互動選單：即時列出所有帳號 → 選帳號 → 調速度或啟動/暫停 ----
    // 選單以 inline keyboard 呈現，callback_data 格式：sp|<action>|<accountId前8碼>|...
    async function accountMenu() {
        const containers = await fetchContainers();
        const accounts = listAccounts(containers);
        if (accounts.length === 0) {
            return { text: '目前沒有任何帳號', reply_markup: { inline_keyboard: [[{ text: '關閉', callback_data: 'sp|x' }]] } };
        }
        const rows = accounts.map((a) => [{
            text: `${statusLabel(a)}　${a.email}　${modeLabel(a.mode)}`,
            callback_data: `sp|pick|${a.accountId.slice(0, 8)}`,
        }]);
        rows.push([{ text: '取消', callback_data: 'sp|x' }]);
        return { text: '目前的帳號（點選以調整）：', reply_markup: { inline_keyboard: rows } };
    }
    function accountDetailMenu(a) {
        const id8 = a.accountId.slice(0, 8);
        const mk = (m) => ({ text: (a.mode === m ? '✓ ' : '') + modeLabel(m), callback_data: `sp|set|${id8}|${m}` });
        const toggle = (a.containerStatus === 'running' && a.status === 'active')
            ? { text: '⏸ 暫停帳號', callback_data: `sp|st|${id8}|stopped` }
            : { text: '▶️ 啟動帳號', callback_data: `sp|st|${id8}|running` };
        return {
            text: `${a.email}\n狀態：${statusLabel(a)}・速度：${modeLabel(a.mode)}\n選擇動作：`,
            reply_markup: {
                inline_keyboard: [
                    [mk('humanlike'), mk('normal')],
                    [mk('speed_2x'), mk('speed_3x'), mk('speed_5x')],
                    [toggle],
                    [{ text: '‹ 返回', callback_data: 'sp|back' }, { text: '取消', callback_data: 'sp|x' }],
                ],
            },
        };
    }

    // ---- 手動調速指令（僅本人）----
    // /speed                    → 互動選單（即時列出所有帳號 → 調速/啟停）
    // /speed <email開頭> <mode> → 快速直接套用（也支援舊代號 c20x / kenny）
    bot.onText(/^\/speed(?:@\S+)?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i, async (msg, match) => {
        if (msg.from.id !== OWNER_ID) return;
        const who = (match[1] || '').toLowerCase();
        const mode = (match[2] || '').toLowerCase();
        if (who || mode) { // 快速路徑
            if (!VALID_MODES.includes(mode)) {
                return bot.sendMessage(msg.chat.id,
                    '用法：/speed <email開頭或代號> <humanlike|normal|speed_2x|speed_3x|speed_5x>\n（或直接 /speed 用選單）',
                    { message_thread_id: msg.message_thread_id });
            }
            try {
                let email = WHO_EMAIL[who]; // 舊代號優先
                if (!email) {
                    const containers = await fetchContainers();
                    const hits = listAccounts(containers).filter((a) => a.email.toLowerCase().startsWith(who));
                    if (hits.length === 0) {
                        return bot.sendMessage(msg.chat.id, `找不到 email 以「${who}」開頭的帳號`, { message_thread_id: msg.message_thread_id });
                    }
                    if (hits.length > 1) {
                        return bot.sendMessage(msg.chat.id, `「${who}」符合多個帳號：\n${hits.map((a) => a.email).join('\n')}\n請多打幾個字`, { message_thread_id: msg.message_thread_id });
                    }
                    email = hits[0].email;
                }
                const applied = await applyMode(email, mode);
                bot.sendMessage(msg.chat.id, applied ? `已將 ${email} 設為 ${modeLabel(mode)}` : `找不到 ${email} 帳號`,
                    { message_thread_id: msg.message_thread_id });
            } catch (e) {
                bot.sendMessage(msg.chat.id, `調速失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
            }
            return;
        }
        try {
            const menu = await accountMenu();
            bot.sendMessage(msg.chat.id, menu.text, { reply_markup: menu.reply_markup, message_thread_id: msg.message_thread_id });
        } catch (e) {
            bot.sendMessage(msg.chat.id, `讀取帳號失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
        }
    });

    // ---- 處理選單按鈕點擊 ----
    bot.on('callback_query', async (query) => {
        const data = query.data || '';
        if (!data.startsWith('sp|')) return; // 只處理本模組的按鈕
        if (query.from.id !== OWNER_ID) return bot.answerCallbackQuery(query.id, { text: '無權限', show_alert: true });
        const msg = query.message;
        const editOpts = { chat_id: msg.chat.id, message_id: msg.message_id };
        const parts = data.split('|');
        const action = parts[1];
        try {
            if (action === 'x') {
                await bot.editMessageText('已取消', editOpts);
            } else if (action === 'back') {
                const menu = await accountMenu();
                await bot.editMessageText(menu.text, { ...editOpts, reply_markup: menu.reply_markup });
            } else if (action === 'pick') {
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, parts[2]);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    const menu = accountDetailMenu(acc);
                    await bot.editMessageText(menu.text, { ...editOpts, reply_markup: menu.reply_markup });
                }
            } else if (action === 'set') {
                const idp = parts[2], mode = parts[3];
                if (!VALID_MODES.includes(mode)) { return bot.answerCallbackQuery(query.id, { text: '參數錯誤' }); }
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, idp);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    if (acc.mode !== mode) await setDispatch(acc.containerId, acc.accountId, mode);
                    await bot.editMessageText(`已將 ${acc.email} 設為 ${modeLabel(mode)}`, editOpts);
                }
            } else if (action === 'st') {
                const idp = parts[2], status = parts[3];
                if (!['running', 'stopped'].includes(status)) { return bot.answerCallbackQuery(query.id, { text: '參數錯誤' }); }
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, idp);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    const isRunning = acc.containerStatus === 'running' && acc.status === 'active';
                    if ((status === 'running') !== isRunning) await setStatus(acc.containerId, acc.accountId, status);
                    await bot.editMessageText(
                        `${status === 'running' ? '▶️ 已啟動' : '⏸ 已暫停'} ${acc.email}`, editOpts);
                }
            }
            bot.answerCallbackQuery(query.id);
        } catch (e) {
            try { await bot.editMessageText(`操作失敗：${e.message}`, editOpts); } catch { /* ignore */ }
            bot.answerCallbackQuery(query.id, { text: '失敗' });
        }
    });

    // ---- 額度查詢（僅本人）：/quota ----
    bot.onText(/^\/(quota|額度|budget)(?:@\S+)?\b/i, async (msg) => {
        if (msg.from.id !== OWNER_ID) return;
        try {
            const containers = await fetchContainers();
            const accounts = new Map();
            for (const c of containers || []) {
                for (const a of c.accounts || []) accounts.set(a.id, { ...a, containerStatus: c.status });
            }
            const groups = new Map([['Codex', []], ['Claude', []], ['其他', []]]);
            const now = Date.now();
            const addEntry = (account, text, weeklyResetAt) => {
                const group = { openai: 'Codex', anthropic: 'Claude' }[account.type] || '其他';
                groups.get(group).push({ text, resetTime: quotaResetTime(weeklyResetAt) });
            };
            const covered = new Set(); // 有額度資料的 accountId
            for (const c of containers || []) {
                const budgets = await fetchBudgets(c.id);
                for (const b of budgets) {
                    covered.add(b.accountId);
                    const account = accounts.get(b.accountId) || {};
                    const email = account.email || String(b.accountId).slice(0, 8);
                    const weeklyLow = b.weeklyPct != null && b.weeklyPct !== '' && Number.isFinite(Number(b.weeklyPct)) && Number(b.weeklyPct) <= 5;
                    const weeklyEmpty = weeklyLow && Number(b.weeklyPct) <= 0;
                    const warn = !weeklyLow && b.fiveHourPct != null && b.fiveHourPct <= 0 ? '（5H 已用罄）' : '';
                    const untilReset = quotaResetTime(b.weeklyResetAt) - now;
                    const soon = untilReset > 0 && untilReset <= 24 * 60 * 60 * 1000 ? '⏰' : '';
                    addEntry(account, [
                        `${email}（${quotaPlanLabel(account, b)}）${warn}`,
                        weeklyEmpty ? '　🔴週額度用罄（0%）' : weeklyLow ? `　週剩 ${quotaRemainingLabel(b.weeklyPct)}` : `　5 小時剩 ${quotaRemainingLabel(b.fiveHourPct)}・週剩 ${quotaRemainingLabel(b.weeklyPct)}`,
                        weeklyLow ? `　${soon}週重置 ${fmtTaipei(b.weeklyResetAt)}` : `　5H 重置 ${fmtTaipei(b.resetAt)}・${soon}週重置 ${fmtTaipei(b.weeklyResetAt)}`
                    ].join('\n'), b.weeklyResetAt);
                }
            }
            // 平台對「暫停/剛加入還沒跑過」的帳號不會回額度資料，逐一列出原因，不再無聲空白
            const missing = [...accounts.entries()].filter(([id]) => !covered.has(id));
            for (const [, a] of missing) {
                addEntry(a, `${a.email}（${quotaPlanLabel(a)}・${statusLabel(a)}）\n　尚無額度資料（通常帳號啟動並開始跑任務後才會出現）`);
            }
            const opts = { message_thread_id: msg.message_thread_id };
            const costLine = formatMonthlyCost(calculateMonthlyCost(containers));
            if (covered.size === 0 && missing.length === 0) {
                await bot.sendMessage(msg.chat.id, `DeRouter 剩餘額度\n${costLine}\n\n目前沒有任何帳號`, opts);
            }
            for (const [group, entries] of groups) {
                if (!entries.length) continue;
                entries.sort((a, b) => a.resetTime === b.resetTime ? 0 : a.resetTime < b.resetTime ? -1 : 1);
                const heading = `DeRouter 剩餘額度 — ${group}\n${costLine}\n⏰週重置≤24h｜🔴用罄｜🟠剩≤5%｜🧊剩≥80%（用得少）`;
                let text = heading;
                for (const { text: entry } of entries) {
                    if (text.length + entry.length + 2 > 3900) {
                        await bot.sendMessage(msg.chat.id, text, opts);
                        text = `${heading}（續）`;
                    }
                    text += `\n\n${entry}`;
                }
                await bot.sendMessage(msg.chat.id, text, opts);
            }
        } catch (e) {
            bot.sendMessage(msg.chat.id, `讀取額度失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
        }
    });

    if (ENABLED) {
        scheduleTick();                       // 啟動時先補到正確相位
        setInterval(scheduleTick, TICK_MS);   // 每分鐘檢查相位
        setInterval(thresholdTick, EARN_MS);  // 每 5 分鐘檢查收益門檻
    }
    console.log(`✅ DeRouter 自動調速模組已啟動（${ENABLED ? '排程開啟' : '排程停用，僅 /speed 手動'}；c20x：08:00→5x、當日≥$${c20x_THRESHOLD}→2x、00:00→normal；kenny：08:00→2x、00:00→normal）`);
}

module.exports = { initDispatch };
