const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    let selected;
    let handler;
    let expression;
    let apiCalls = 0;
    let chainCalls = 0;
    const sent = [];
    const files = [];
    const sandbox = {
        module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
        process: { env: { DEROUTER_MGMT_KEY: 'test', DEROUTER_CHAT_ID: '123' } },
        __dirname: path.resolve(__dirname, '..'), setInterval() {},
        require: name => {
            if (name === './earnings-api') return { fetchEarnings: async () => { apiCalls += 1; throw new Error('API offline'); } };
            if (name === './chain-earnings') return {
                fetchChainEarnings: async () => { chainCalls += 1; return {}; },
                formatChainEarnings: (data, automatic) => automatic ? 'chain automatic' : 'chain manual',
            };
            if (name === './costs') return {};
            if (name === 'fs') return {
                readFileSync: file => file.endsWith('derouter_state.json') ? JSON.stringify({ earningsSource: selected }) : '',
                writeFileSync: (file, text) => { files.push(file); selected = JSON.parse(text).earningsSource; },
            };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../derouter.js'), 'utf8'), sandbox);
    sandbox.module.exports.initDeRouter({
        onText: (regex, callback) => { expression = regex; handler = callback; },
        sendMessage: async (id, text, options) => sent.push({ text, options }),
    });
    return {
        sent, files,
        counts: () => ({ apiCalls, chainCalls }),
        run: (command, id = 123) => handler({ from: { id }, chat: { id: 123 }, message_thread_id: 7 }, expression.exec(command)),
    };
}

test('auto falls back on API failure and preserves topic replies without writing API earnings', async () => {
    const bot = setup();
    await bot.run('/derouter');
    assert.equal(bot.sent[0].text, 'chain automatic');
    assert.equal(bot.sent[0].options.message_thread_id, 7);
    assert.equal(bot.files.length, 0);
});

test('manual chain persists and skips API requests on subsequent queries', async () => {
    const bot = setup();
    const before = bot.counts().apiCalls;
    await bot.run('/derouter chain');
    await bot.run('/earn');
    assert.equal(bot.counts().apiCalls, before);
    assert.equal(bot.counts().chainCalls, 2);
    assert.ok(bot.sent.every(m => m.text === 'chain manual'));
});

test('manual api reports API errors without fallback; auto re-enables fallback', async () => {
    const bot = setup();
    await bot.run('/derouter api');
    assert.match(bot.sent[0].text, /API offline/);
    assert.equal(bot.counts().chainCalls, 0);
    await bot.run('/收益 auto');
    assert.equal(bot.sent[1].text, 'chain automatic');
});

test('non-owner cannot switch source or query chain', async () => {
    const bot = setup();
    await bot.run('/derouter chain', 999);
    assert.equal(bot.sent.length, 0);
    assert.equal(bot.files.length, 0);
    assert.equal(bot.counts().chainCalls, 0);
});
