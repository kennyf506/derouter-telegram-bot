require('dotenv').config();

// ==========================================
// 🤖 個人專屬 DeRouter bot
// ------------------------------------------
//  - 收益推播（突破提醒、每日損益報告、達標提醒、/derouter 查詢）→ derouter.js
//  - 自動調速（依時間與當日收益調 dispatch_mode、/speed 手動）    → dispatch.js
// ==========================================
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('❌ 缺少 TELEGRAM_BOT_TOKEN，請在 .env 填入你新建的 bot token');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log('🤖 個人 DeRouter bot 已啟動');

// 掛載兩個模組
const { initDeRouter } = require('./derouter');
const { initDispatch } = require('./dispatch');
initDeRouter(bot);
initDispatch(bot);
require('./chain-earnings').startChainSync();

// polling 自動復原：斷網 (EFATAL/ENOTFOUND) 會讓 polling 默默停掉，
// 這裡在錯誤發生後 10 秒自動重啟 polling，避免 bot 看似 online 其實卡死
let pollingRestartScheduled = false;
bot.on('polling_error', (error) => {
    console.error(`[polling_error] ${error.code}: ${error.message}`);
    if (pollingRestartScheduled) return;
    pollingRestartScheduled = true;
    setTimeout(async () => {
        try {
            await bot.stopPolling();
            await bot.startPolling();
            console.log('🔄 polling 已自動重啟');
        } catch (e) {
            console.error('🔄 polling 重啟失敗:', e.message);
        } finally {
            pollingRestartScheduled = false;
        }
    }, 10000);
});

// 私聊指令選單
bot.setMyCommands([
    { command: 'derouter', description: '查詢今日/本週/累計收益' },
    { command: 'quota', description: '查詢各帳號剩餘額度（5 小時／週）' },
    { command: 'speed', description: '調整帳號速度（開選單）' },
]).catch(() => {});
