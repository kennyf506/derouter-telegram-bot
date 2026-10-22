const axios = require('axios');

async function fetchEarnings() {
    const key = process.env.DEROUTER_MGMT_KEY;
    if (!key) throw new Error('缺少 DEROUTER_MGMT_KEY 環境變數');
    try {
        const { data } = await axios.get('https://api.derouter.network/api/billing/earnings', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 15000,
        });
        return data;
    } catch (error) {
        const response = error.response;
        if (response?.status === 403 && response.data?.code === 'scope_denied'
            && response.data?.error === 'Manager key lacks scope: usage') {
            const denied = new Error('DeRouter management key 缺少 usage 權限，無法讀取收益。請在 DeRouter 後台為金鑰啟用 usage；若需建立新金鑰，請保留目前帳號管理權限，並更新 .env 的 DEROUTER_MGMT_KEY 後重啟 bot。');
            denied.code = 'DEROUTER_USAGE_SCOPE_REQUIRED';
            throw denied;
        }
        if (response?.status === 401) {
            const unauthorized = new Error('DeRouter management key 無效或已過期，請更新 .env 的 DEROUTER_MGMT_KEY 後重啟 bot。');
            unauthorized.code = 'DEROUTER_KEY_INVALID';
            throw unauthorized;
        }
        throw error;
    }
}

module.exports = { fetchEarnings };
