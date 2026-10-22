const axios = require('axios');

// US monthly list prices, before tax. Verified 2026-10-21:
// https://claude.com/pricing
// https://learn.chatgpt.com/docs/pricing
// K–12 offer: https://help.openai.com/en/articles/12844995
const PRICE_DATE = '2026-10-21';

function accountPrice(account, now) {
    const { type, plan, seatTier, rateLimitTier } = account;
    if (type === 'anthropic') {
        if (plan === 'team') {
            if (seatTier === 'team_standard') return { label: 'Claude Team Standard', price: 25 };
            if (['team_tier_1', 'team_premium'].includes(seatTier)) return { label: 'Claude Team Premium', price: 125 };
        }
        if (plan === 'pro') return { label: 'Claude Pro', price: 20 };
        if (plan === 'max' && rateLimitTier === 'default_claude_max_5x') return { label: 'Claude Max 5x', price: 100 };
        if (plan === 'max' && rateLimitTier === 'default_claude_max_20x') return { label: 'Claude Max 20x', price: 200 };
        if (plan === 'free') return { label: 'Claude Free', price: 0 };
    }
    if (type === 'openai') {
        if (plan === 'plus') return { label: 'Codex / ChatGPT Plus', price: 20 };
        if (plan === 'free') return { label: 'Codex / ChatGPT Free', price: 0 };
        if (plan === 'go') return { label: 'Codex / ChatGPT Go', price: 8 };
        // Generic "pro" does not distinguish $100 / $200 / $500 subscriptions.
        if (plan === 'k12' && now < Date.parse('2028-07-01T00:00:00Z')) {
            return { label: 'Codex / ChatGPT K12（免費至 2028/06）', price: 0 };
        }
    }
    return { label: `${type || '未知平台'} / ${plan || '未知方案'}${seatTier ? ` / ${seatTier}` : ''}`, price: null };
}

function calculateMonthlyCost(containers, now = Date.now()) {
    const seen = new Set();
    const groups = new Map();
    for (const container of containers || []) {
        for (const account of container.accounts || []) {
            // An account may appear in more than one container; count its subscription once.
            const identity = account.email?.trim().toLowerCase() || account.id;
            const key = identity ? `${account.type}:${identity}` : account;
            if (seen.has(key)) continue;
            seen.add(key);
            const { label, price } = accountPrice(account, now);
            if (!groups.has(label)) groups.set(label, { label, price, count: 0 });
            groups.get(label).count += 1;
        }
    }
    const items = [...groups.values()];
    return {
        items,
        total: items.reduce((sum, item) => sum + (item.price ?? 0) * item.count, 0),
        unknownCount: items.reduce((sum, item) => sum + (item.price == null ? item.count : 0), 0),
    };
}

function formatMonthlyCost(cost) {
    const lines = [`💸 每月成本${cost.unknownCount ? '已知小計' : '總計'}：US$${cost.total.toFixed(2)}`];
    for (const item of cost.items) {
        lines.push(item.price == null
            ? `　${item.label} × ${item.count}：未計價`
            : `　${item.label}：${item.count} × US$${item.price} = US$${(item.count * item.price).toFixed(2)}`);
    }
    if (cost.unknownCount) lines.push(`⚠️ ${cost.unknownCount} 個帳號方案／價格無法確認，未列入小計`);
    lines.push(`美區月繳牌價・未稅・不含加購用量（價格核對 ${PRICE_DATE}）`);
    return lines.join('\n');
}

async function fetchMonthlyCost() {
    const { data } = await axios.get('https://api.derouter.network/api/containers', {
        headers: { Authorization: `Bearer ${process.env.DEROUTER_MGMT_KEY}` },
        timeout: 15000,
    });
    if (!Array.isArray(data)) throw new Error('帳號清單格式錯誤，無法計算月成本');
    return calculateMonthlyCost(data);
}

module.exports = { calculateMonthlyCost, formatMonthlyCost, fetchMonthlyCost };
