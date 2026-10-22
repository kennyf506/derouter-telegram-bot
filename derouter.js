// ==========================================
// 💰 DeRouter 收益推播模組
// ------------------------------------------
// 功能：
//   1. 每 5 分鐘輪詢一次收益，「當日收益」每跨過一個整數美元就提醒（訊息附累計金額）
//   2. 每天早上 8 點（台北時間＝UTC 換日）主動送出前一日總結
//   3. 當日收益跨過每個門檻（預設 $7、$14）時提醒達標，附平均達標時間與早/晚比較
//   4. 指令即時查詢：/derouter（或 /earn、/收益）
//
// 需要 .env 設定：
//   DEROUTER_MGMT_KEY  = 你的 DeRouter management key（sk-mgr-...）
//   DEROUTER_CHAT_ID   = 要接收自動推播的 Telegram ID
//   DEROUTER_ALERT_STEP= （選填）每跨過多少美元提醒一次，預設 1
//   DEROUTER_DAILY_HOUR= （選填）每天幾點送總結（台北時間 0–23），預設 8
//   DEROUTER_BILLING_START=（選填）第一期訂閱起始日 YYYY-MM-DD，之後每月自動換期
//   月成本依目前帳號數量與美區月繳牌價自動計算
//   DEROUTER_DAILY_COST=   （選填）日成本，用於昨日損益
// ==========================================
const fs = require('fs');
const path = require('path');
const { fetchMonthlyCost, formatMonthlyCost } = require('./costs');
const { fetchEarnings } = require('./earnings-api');
const { fetchChainEarnings, formatChainEarnings } = require('./chain-earnings');

const STATE_FILE = path.join(__dirname, 'derouter_state.json');
// 每日紀錄（append-only，一天一行）。平台的 allTime 會被回頭下修、不可信，
// 所以「本期已賺」一律以這個檔為準，state 裡的數字只是它的快取鏡像。
const DAILY_LOG = path.join(__dirname, 'derouter_daily.jsonl');

const POLL_MS = 5 * 60 * 1000;   // 每 5 分鐘輪詢一次
// 每跨過多少美元通知一次（可用 .env 的 DEROUTER_ALERT_STEP 覆寫，預設 1＝每個整數）
const ALERT_STEP = Math.max(1, Number(process.env.DEROUTER_ALERT_STEP) || 1);
// 每天幾點送總結（台北時間 0–23，可用 .env 的 DEROUTER_DAILY_HOUR 覆寫，預設 8＝UTC 換日時刻）
const DAILY_HOUR = (() => {
    const raw = (process.env.DEROUTER_DAILY_HOUR || '').trim();
    if (raw === '') return 8;               // 未設定或留空 → 預設 8
    const h = Number(raw);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
})();
const TZ = 'Asia/Taipei';        // 以台北時間為準

// ---- 訂閱成本（供每日損益報告用；沒設定就只顯示收益不算損益）----
// BILLING_START 是「第一期」的起始日，之後每月同日自動滾入新的一期，不需手動更新
const BILLING_START = (process.env.DEROUTER_BILLING_START || '').trim(); // YYYY-MM-DD
const DAILY_COST = Number(process.env.DEROUTER_DAILY_COST) || 0;
// 每日「達標」門檻（美元，可多個）。每個門檻各自記錄達標時間與平均，達標時提醒。
// 預設＝日成本與其兩倍（例：7 → 7,14）；可用 DEROUTER_GOAL_TARGETS=7,14 覆寫。
const GOAL_TARGETS = (() => {
    const raw = (process.env.DEROUTER_GOAL_TARGETS || '').trim();
    if (raw) return raw.split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    return DAILY_COST > 0 ? [DAILY_COST, DAILY_COST * 2] : [];
})();

// 回傳包含 dateStr 那一天的「本期起始日」（從 BILLING_START 每月同日滾動）
// 例：BILLING_START=2026-07-15 → 7/15–8/14 回傳 07-15、8/15 起回傳 08-15…
function currentPeriodStart(dateStr) {
    const [sy, sm, sd] = BILLING_START.split('-').map(Number);
    const [y, mo, day] = dateStr.split('-').map(Number);
    let months = (y - sy) * 12 + (mo - sm);
    if (day < sd) months -= 1;      // 這個月的續訂日還沒到 → 仍屬上一期
    if (months < 0) months = 0;     // dateStr 早於第一期 → 視為第一期
    const total = sm - 1 + months;
    const py = sy + Math.floor(total / 12);
    const pm = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const pd = Math.min(sd, lastDay); // 該月沒有這一天（如 31 號）就取月底
    return `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`;
}

// 下一期的起始日（+32 天必落在下一期內，再反查其起始日）
function nextPeriodStart(periodStart) {
    const start = new Date(`${periodStart}T00:00:00Z`);
    const probe = new Date(start.getTime() + 32 * 86400000).toISOString().slice(0, 10);
    return currentPeriodStart(probe);
}

// 本期總天數（到下一期起始日為止）
function daysInPeriod(periodStart) {
    const start = new Date(`${periodStart}T00:00:00Z`);
    const next = new Date(`${nextPeriodStart(periodStart)}T00:00:00Z`);
    return Math.round((next - start) / 86400000);
}

// ---- 每日紀錄：讀 / 寫 / 依期別加總 ----
function readDailyLog() {
    try {
        return fs.readFileSync(DAILY_LOG, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch {
        return []; // 檔案還不存在
    }
}

function appendDaily(entry) {
    try {
        // 同一天只記一次：重啟或換日邏輯重跑時不會重複累加
        if (readDailyLog().some((e) => e.date === entry.date)) return;
        fs.appendFileSync(DAILY_LOG, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error('[derouter] 無法寫入每日紀錄:', e.message);
    }
}

// 本期已賺＝紀錄檔中屬於本期的日值加總。
// seed 行帶 days 欄位代表它一行涵蓋多天（用於沒有逐日明細的回補）。
function sumPeriod(periodStart) {
    const end = nextPeriodStart(periodStart);
    let earned = 0;
    let days = 0;
    for (const e of readDailyLog()) {
        if (e.date >= periodStart && e.date < end) {
            earned += Number(e.earned) || 0;
            days += Number(e.days) || 1;
        }
    }
    return { earned, days };
}

// ---- 狀態持久化（避免重啟後重複發提醒）----
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { lastAlertAllTime: null, lastDailySent: null };
    }
}
function saveState(s) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    } catch (e) {
        console.error('[derouter] 無法寫入狀態檔:', e.message);
    }
}

// ---- 把收益資料排版成 Telegram 訊息 ----
function formatEarnings(d, projection = '') {
    const m = (n) => `$${Number(n).toFixed(4)}`;
    return (
        `💰 <b>DeRouter 收益</b>\n\n` +
        `📅 今日 Today：<b>${m(d.today)}</b>（${d.todayTasks} tasks）\n` +
        `🗓 本週 Week：<b>${m(d.week)}</b>（${d.weekTasks} tasks）\n` +
        `🏆 累計 AllTime：<b>${m(d.allTime)}</b>（${d.allTimeTasks} tasks）\n` +
        `📨 Requests Served：<b>${d.requestsAll}</b>\n\n` +
        (projection ? `${projection}\n\n` : '') +
        `<i>※ today/week 以 UTC 日界計算（UTC 午夜＝台北早上 8 點換日）</i>`
    );
}

function formatExpectedReturn(d, cost, entries = readDailyLog(), now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const samples = new Map();
    for (const entry of entries) {
        if (entry.date >= cutoff && entry.date < today && (entry.days == null || entry.days === 1)
            && entry.earned != null && entry.earned !== '' && Number.isFinite(Number(entry.earned)) && Number(entry.earned) >= 0) {
            samples.set(entry.date, Number(entry.earned));
        }
    }
    const lines = ['📈 <b>預期月收益率</b>'];
    let dailyAverage;
    if (samples.size) {
        dailyAverage = [...samples.values()].reduce((sum, n) => sum + n, 0) / samples.size;
        lines.push(`依近 7 天已記錄的 ${samples.size} 個收益日，日均 US$${dailyAverage.toFixed(2)}`);
    } else {
        const elapsed = now.getTime() - Date.parse(`${today}T00:00:00Z`);
        if (elapsed < 3600000 || d.today == null || !Number.isFinite(Number(d.today)) || Number(d.today) < 0) {
            return `${lines[0]}\n資料不足，累積完整收益日或 UTC 換日滿 1 小時後顯示`;
        }
        dailyAverage = Number(d.today) / (elapsed / 86400000);
        lines.push(`尚無完整日紀錄，依今日已過 ${(elapsed / 3600000).toFixed(1)} 小時收益推估`);
    }
    const days = BILLING_START ? daysInPeriod(currentPeriodStart(today))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const revenue = dailyAverage * days;
    lines.push(`預期月收益：<b>US$${revenue.toFixed(2)}</b>（以 ${days} 天估算）`);
    if (!cost || cost.unknownCount > 0) {
        lines.push('月成本未完整取得，暫不計算淨利及收益率');
    } else {
        const profit = revenue - cost.total;
        lines.push(`每月成本估算：US$${cost.total.toFixed(2)}`);
        lines.push(`預期月淨利：<b>${profit >= 0 ? '+' : '-'}US$${Math.abs(profit).toFixed(2)}</b>`);
        const roi = cost.total > 0 ? profit / cost.total * 100 : null;
        lines.push(roi == null ? '預期月收益率：不適用（月成本為 0）'
            : `預期月收益率：<b>${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%</b>`);
    }
    lines.push('<i>收益率＝（預期月收益－月成本）÷月成本；依目前速度與美區月繳未稅牌價估算</i>');
    return lines.join('\n');
}

// ---- 每日損益報告排版 ----
function formatDaily(d, state, taipeiDate, cost) {
    const m = (n) => `$${Number(n).toFixed(4)}`;
    const yd = state.yesterdayTotal;
    const lines = [`昨日收益：<b>${yd == null ? '（尚無紀錄）' : m(yd)}</b>`];
    lines.push('', formatMonthlyCost(cost).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const monthlyCost = cost.unknownCount === 0 ? cost.total : null;

    // 日成本由月成本平攤到本期天數，避免手填的 $7×31=217 與月成本 200 對不起來
    const totalDays = state.billingStart ? daysInPeriod(state.billingStart) : 30;
    const dailyCost = monthlyCost == null ? null : monthlyCost / totalDays;

    if (yd != null && dailyCost != null) {
        const pnl = yd - dailyCost;
        const sign = pnl >= 0 ? '+' : '-';
        lines.push(`昨日損益：<b>${sign}$${Math.abs(pnl).toFixed(4)}</b>（日成本 $${dailyCost.toFixed(2)}）`);
    }

    if (state.billingStart && monthlyCost > 0) {
        const { earned, days: doneDays } = sumPeriod(state.billingStart);
        const pct = (earned / monthlyCost) * 100;
        const day = Math.floor(
            (new Date(`${taipeiDate}T00:00:00Z`) - new Date(`${state.billingStart}T00:00:00Z`)) / 86400000
        ) + 1;
        const filled = Math.max(0, Math.min(20, Math.round(pct / 5))); // 20 格，每格 5%
        lines.push(
            '',
            `本期進度（第 ${day} 天／共 ${totalDays} 天）`,
            `　已賺 $${earned.toFixed(2)} ／ 月成本估算 $${monthlyCost}（${pct.toFixed(1)}%）`,
            `　${'▓'.repeat(filled)}${'░'.repeat(20 - filled)}`
        );
        if (doneDays >= 1) {
            // 已賺的部分是事實，不再拿日均去重估它；只用日均推「剩下還沒發生的天數」
            const avg = earned / doneDays;
            const remaining = Math.max(0, totalDays - day + 1);
            const projected = earned + remaining * avg;
            lines.push(`　日均 $${avg.toFixed(2)}（${doneDays} 天）／剩 ${remaining} 天`);
            lines.push(`　推估期末約 $${Math.round(projected)}`);
        }
        // 回寫快取鏡像，方便直接看 state 檔除錯；真相仍以紀錄檔為準
        state.periodEarned = earned;
        state.periodDays = doneDays;
    }

    lines.push('', `累計 AllTime：<b>${m(d.allTime)}</b>`, `Requests Served：<b>${d.requestsAll}</b>`);
    return lines.join('\n');
}

// ---- 記錄 today 的最後數值，UTC 換日時把它存成「昨日總收益」----
// （API 沒有昨日欄位；today 在 UTC 午夜歸零，所以換日前最後一次輪詢的值＝昨日總額）
function trackToday(state, d) {
    const nowDate = new Date().toISOString().slice(0, 10); // UTC 日期
    if (state.todayDate !== nowDate) {
        // 只有在紀錄的日期正好是「昨天」時才採用，避免停機多天後拿到過期數字
        const prev = new Date(`${nowDate}T00:00:00Z`);
        prev.setUTCDate(prev.getUTCDate() - 1);
        const yesterdayStr = prev.toISOString().slice(0, 10);
        state.yesterdayTotal = state.todayDate === yesterdayStr ? state.todayValue : null;
        state.todayDate = nowDate;
        // 把封存好的昨日數字寫進紀錄檔。不能用 allTime 差值算本期收益：平台會回頭下修
        // （實測 8/4–8/24 錢包進帳 300.89，同期 allTime 只長 136.50），差值算法會愈跑愈負。
        // 只在昨天資料連續時記錄；中斷過就留缺行，寧可少算也不要記到錯的一天。
        if (state.yesterdayTotal != null) {
            appendDaily({
                date: yesterdayStr,
                earned: state.yesterdayTotal,
                tasks: state.todayTasks ?? null,
                allTime: Number(d.allTime),   // 留存平台當下的累計值，日後可回查它被下修多少
                period: BILLING_START ? currentPeriodStart(yesterdayStr) : null,
            });
        } else {
            console.warn(`[derouter] ${nowDate} 換日時無連續的昨日資料，紀錄檔留缺行`);
        }
    }
    state.todayValue = Number(d.today);
    state.todayTasks = Number(d.todayTasks);
    // 進入新的一期（含第一次啟動）時記下基準（僅供對帳參考；本期已賺改由紀錄檔推導）
    if (BILLING_START) {
        const periodStart = currentPeriodStart(nowDate);
        if (state.billingStart !== periodStart) {
            state.billingStart = periodStart;
            state.billingBaseline = Number(d.allTime) - Number(d.today);
            // periodEarned／periodDays 不必歸零：由紀錄檔依期別推導，換期自然從 0 起算
        }
    }
    saveState(state);
}

// ---- 今日達標的時間工具 ----
// 「收益日」以 UTC 換日（台北早上 8 點），所以達標耗時＝UTC 午夜起經過的分鐘數
function minutesIntoUtcDay() {
    return Math.floor((Date.now() % 86400000) / 60000);
}
function taipeiClock() {
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
}
function fmtDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h} 小時 ${m} 分鐘` : `${m} 分鐘`;
}
// 把一組「UTC 日內分鐘數」的平均，換算成台北時鐘 HH:MM
function avgClockTaipei(times) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const t = Math.round((avg + 8 * 60) % 1440); // UTC 分鐘 +8 小時 → 台北
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ---- 取得「現在」的台北日期字串與小時，用來判斷是否到 DAILY_HOUR ----
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
// 主啟動函式：把整個模組掛到既有的 bot 上
// ==========================================
function initDeRouter(bot) {
    if (!process.env.DEROUTER_CHAT_ID) {
        console.warn('[derouter] 未設定 DEROUTER_CHAT_ID，收益模組略過啟動');
        return;
    }
    const CHAT_ID = process.env.DEROUTER_CHAT_ID;
    const OWNER_ID = Number(CHAT_ID); // 只有本人能用指令查自己的收益
    let state = loadState();

    // ---- 指令：即時查詢（僅限本人）----
    bot.onText(/^\/(derouter|earn|收益)(?:@\w+)?(?:\s+(auto|api|chain))?\s*$/i, async (msg, match) => {
        if (msg.from.id !== OWNER_ID) return; // 非本人一律忽略，保護個人收益隱私
        const selected = match?.[2]?.toLowerCase();
        if (selected) {
            state.earningsSource = selected;
            saveState(state);
        }
        const source = ['api', 'chain'].includes(state.earningsSource) ? state.earningsSource : 'auto';
        const reply = text => bot.sendMessage(msg.chat.id, text, {
            parse_mode: 'HTML', message_thread_id: msg.message_thread_id,
        });
        try {
            if (source === 'chain') {
                await reply(formatChainEarnings(await fetchChainEarnings()));
                return;
            }
            let d;
            try { d = await fetchEarnings(); }
            catch (apiError) {
                if (source === 'api') throw apiError;
                console.error('[derouter] API 無法讀取，切換鏈上統計:', apiError.message);
                await reply(formatChainEarnings(await fetchChainEarnings(), true));
                return;
            }
            trackToday(state, d);
            saveState(state);
            let cost = null;
            try { cost = await fetchMonthlyCost(); }
            catch (e) { console.error('[derouter] 月成本讀取失敗:', e.message); }
            await reply(formatEarnings(d, formatExpectedReturn(d, cost)));
        } catch (e) {
            bot.sendMessage(msg.chat.id, `❌ 讀取 DeRouter 收益失敗：${e.message}`, {
                message_thread_id: msg.message_thread_id,
            });
        }
    });

    // ---- 每 5 分鐘輪詢：今日收益每「跨過一個 $ALERT_STEP 關卡」就提醒 ----
    // 以「當日收益」為基礎（每天 UTC 換日歸零、關卡重來），訊息中仍附上累計金額。
    async function poll() {
        try {
            const d = await fetchEarnings();
            trackToday(state, d);                      // 順手記錄，供每日總結算「昨日收益」
            checkDailyGoal(d);                         // 今日是否達各門檻（達標提醒）
            const today = Number(d.today);             // 當日收益（UTC 午夜歸零）
            const at = Number(d.allTime);              // 累計值
            const nowUtcDate = new Date().toISOString().slice(0, 10);
            const levelNow = Math.floor(today / ALERT_STEP); // 今日跨到第幾個關卡

            if (state.todayLevelDate !== nowUtcDate) {
                // 新的一天：today 已歸零，重設每日關卡基準，不發提醒
                state.todayLevelDate = nowUtcDate;
                state.lastTodayLevel = levelNow;
                saveState(state);
            } else if (state.lastTodayLevel == null) {
                state.lastTodayLevel = levelNow;
                saveState(state);
            } else if (levelNow > state.lastTodayLevel) {
                state.lastTodayLevel = levelNow; // 基準推進到目前關卡
                saveState(state);
                bot.sendMessage(
                    CHAT_ID,
                    `DeRouter 今日收益突破 $${levelNow * ALERT_STEP}（目前累計 $${at.toFixed(4)}、${d.allTimeTasks} tasks）`
                );
            }
        } catch (e) {
            console.error('[derouter] 輪詢失敗:', e.message);
        }
    }

    // ---- 今日達標：today 跨過每個 $GOAL_TARGETS 門檻 → 各提醒一次並記錄達標耗時 ----
    // 每個門檻各自維護歷史達標耗時（state.goals[門檻].times，最多 60 筆），用來算平均、比早晚。
    function checkDailyGoal(d) {
        if (GOAL_TARGETS.length === 0) return;
        const today = Number(d.today);
        const nowDate = new Date().toISOString().slice(0, 10); // UTC 收益日
        if (!state.goals) state.goals = {};

        for (const target of GOAL_TARGETS) {
            if (today < target) continue;              // 尚未達此門檻
            const key = String(target);
            const g = state.goals[key] || { date: null, times: [] };
            if (g.date === nowDate) continue;          // 今天此門檻已提醒過

            const mins = minutesIntoUtcDay();
            const prior = Array.isArray(g.times) ? g.times : [];
            let extra = '';
            if (prior.length > 0) {
                extra += `\n平均達標時間 ${avgClockTaipei(prior)}`;
                const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
                const diff = Math.round(avg - mins); // 正＝比平均早
                extra += diff === 0 ? '\n與平均達標時間相同'
                    : diff > 0 ? `\n較平均早了 ${fmtDuration(diff)}達標`
                    : `\n較平均晚了 ${fmtDuration(-diff)}達標`;
            }
            g.date = nowDate;
            g.times = [...prior, mins].slice(-60);
            state.goals[key] = g;
            saveState(state);
            bot.sendMessage(
                CHAT_ID,
                `達成今日 $${target} 目標（${taipeiClock()}，今日收益 $${today.toFixed(4)}）` + extra
            );
        }
    }

    // ---- 每分鐘檢查一次：到台北 08:00（UTC 換日）且今天還沒送過 → 送前一日總結 ----
    async function dailyCheck() {
        const { date, hour } = taipeiNow();
        if (hour === DAILY_HOUR && state.lastDailySent !== date) {
            state.lastDailySent = date;
            saveState(state);
            try {
                const d = await fetchEarnings();
                const cost = await fetchMonthlyCost();
                trackToday(state, d); // 讓換日邏輯先跑，確保 yesterdayTotal／基準已更新
                // 依時段選問候語（早/午/晚），避免半夜還說「早安」
                const greet = DAILY_HOUR < 5 ? '夜深了' :
                              DAILY_HOUR < 12 ? '早安' :
                              DAILY_HOUR < 18 ? '午安' : '晚安';
                bot.sendMessage(
                    CHAT_ID,
                    `<b>${greet}！DeRouter 每日損益報告</b>\n\n` + formatDaily(d, state, date, cost),
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(CHAT_ID, `每日損益報告讀取失敗：${e.message}`);
            }
        }
    }

    poll();                          // 啟動時先跑一次（建立基準）
    setInterval(poll, POLL_MS);      // 每 5 分鐘
    setInterval(dailyCheck, 60 * 1000); // 每分鐘檢查是否到 09:00
    console.log(`✅ DeRouter 收益推播模組已啟動（今日每 $${ALERT_STEP} 提醒、達標門檻 $${GOAL_TARGETS.join('/$') || '—'}、每天 ${String(DAILY_HOUR).padStart(2, '0')}:00 送總結）`);
}

module.exports = { initDeRouter };
