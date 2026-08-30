/**
 * 浏览器端端到端测试（需要联网 + Playwright/Chromium）
 *
 *   node test/browser.js
 *
 * 真的把 index.html 跑起来，点「加载池子信息」，看 V2 / V3 / V4 三种池子
 * 是不是都能算出「需要多少资金」。捕获所有 console 报错和页面异常。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8931;

// 环境里预装的 Chromium 版本可能和 npm 装的 playwright 期望的版本对不上，
// 直接指到预装的可执行文件，避免去下载浏览器
const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome'
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p));

// 容器出网要走本地代理，Chromium 默认不认；代理又是自签 CA 做的 TLS 中转，
// 所以测试环境里同时要忽略证书错误
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || null;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const UPSTREAM_RPC = process.env.RPC_URL || 'https://rpc-bsc.48.club';

/**
 * 本地静态服务器，外加一个 /rpc 中转。
 *
 * 中转的原因：这个沙箱里 Chromium 直连公网 RPC 会被代理 reset（Node 和 curl 都正常），
 * 属于环境限制而非代码问题。用 Node 转一手，页面里的 fetch、模块加载、求解、渲染
 * 这些真正要测的东西照样全程走一遍。
 */
function serve() {
    return new Promise(resolve => {
        const server = http.createServer(async (req, res) => {
            if (req.url === '/rpc') {
                const chunks = [];
                for await (const c of req) chunks.push(c);
                try {
                    const up = await fetch(UPSTREAM_RPC, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: Buffer.concat(chunks)
                    });
                    const body = await up.text();
                    res.writeHead(up.status, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(body);
                } catch (e) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: String(e) } }));
                }
                return;
            }
            const rel = decodeURIComponent(req.url.split('?')[0]);
            const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
            if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(fs.readFileSync(file));
        });
        server.listen(PORT, () => resolve(server));
    });
}

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
    (ok ? pass++ : fail++);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

async function runCase(page, label, setup) {
    console.log(`\n── ${label} ─────────────────────────────────`);
    const errors = [];
    const onErr = e => errors.push('pageerror: ' + e.message);
    const onConsole = m => { if (m.type() === 'error') errors.push('console: ' + m.text()); };
    page.on('pageerror', onErr);
    page.on('console', onConsole);

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#rpcUrl', `http://localhost:${PORT}/rpc`);
    await setup(page);
    await page.click('button:has-text("加载池子信息")');

    // 等池子信息面板出现
    try {
        await page.waitForSelector('#poolInfo:not(.hidden)', { timeout: 90000 });
    } catch (e) {
        check(label + ' 加载', false, '池子信息面板未出现；错误: ' + errors.slice(0, 3).join(' | '));
        page.off('pageerror', onErr); page.off('console', onConsole);
        return;
    }

    const badge = (await page.textContent('#poolTypeBadge')).trim();
    const price = (await page.textContent('#currentPrice')).trim();
    console.log(`  ${badge}`);
    console.log(`  ${price}`);
    check('加载池子', !!badge && price.includes('='));

    // 等自动定价把目标市值填上
    await page.waitForFunction(
        () => document.getElementById('targetMarketCap').value !== '', null, { timeout: 60000 }
    ).catch(() => {});

    // 按 +10% 市值，触发求解
    await page.click('button:has-text("+10%")');
    await page.waitForFunction(() => {
        const t = document.getElementById('requiredAmount').textContent;
        return t && t !== '-' && t !== '计算中…';
    }, null, { timeout: 90000 }).catch(() => {});

    const required = (await page.textContent('#requiredAmount')).trim();
    const targetCap = (await page.textContent('#targetMarketCapH')).trim();
    const impact = (await page.textContent('#priceImpact')).trim();
    console.log(`  目标市值 ${targetCap} · 价格影响 ${impact}`);
    console.log(`  → ${required}`);

    check('+10% 市值求出资金量',
        /净流入|净流出/.test(required) && !/计算中|求解失败|^-$/.test(required));
    // 这一条正是原来因为 decimals0 未定义而永远不更新的地方
    check('目标市值/价格影响已更新', targetCap !== '-' && impact !== '0%' && impact !== '-');

    // 只把真正的 JS 异常算失败。
    // 资源加载失败（429 限流、analytics 被墙）不算：RPC 层本来就有重试，
    // 真的丢了数据会通过 incomplete 标记显式报出来，而不是静默给错数。
    const realErrors = errors.filter(e =>
        !/favicon|gtag|googletagmanager/.test(e) &&
        !/Failed to load resource/.test(e) &&
        !/\bERR_[A-Z_]+/.test(e));
    check('无 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    // 结果里若带「数据未读回」的警示，说明有请求确实丢了，单独提示
    if (/部分链上数据未读回/.test(required)) {
        console.log('  注意：本次有链上请求未读回（RPC 限流），结果已被标记为可能偏小');
    }

    page.off('pageerror', onErr);
    page.off('console', onConsole);
}

(async () => {
    const server = await serve();
    const launchOpts = {};
    if (CHROME) launchOpts.executablePath = CHROME;
    if (PROXY) launchOpts.proxy = { server: PROXY, bypass: 'localhost,127.0.0.1' };
    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    console.log('Chromium:', CHROME || '(默认)', '| 代理:', PROXY || '(无)');

    try {
        await runCase(page, 'V2 池（PancakeSwap WBNB/BUSD）', async p => {
            await p.fill('#poolAddress', '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae');
        });

        await runCase(page, 'V3 池（PancakeSwap WBNB/USDT 0.05%）', async p => {
            await p.fill('#poolAddress', '0x36696169c63e42cd08ce11f5deebbcebae652050');
        });

        await runCase(page, 'V4 池（Uniswap V4 · PoolKey）', async p => {
            await p.check('#useV4PoolKey');
            await p.fill('#v4Currency0', '0x4c42e2217b4c28ab0df322373dd25e974a024444');
            await p.fill('#v4Currency1', '0xce24439f2d9c6a2289f741120fe202248b666666');
            await p.fill('#v4Fee', '200');
            await p.fill('#v4TickSpacing', '4');
            await p.fill('#v4Hooks', '0x0000000000000000000000000000000000000000');
            // poolId 应该被自动算出来并回填到地址框
            const id = (await p.textContent('#v4ComputedId')).trim();
            check('PoolKey 自动算出 poolId',
                id === '0x26b9ede57158097cb1c2688a5be7383acda1f67d75199fe88bfe58079ed359bc', id);
        });

        // 切换基准也要能正常重算
        console.log('\n── 切换基准 ─────────────────────────────────');
        await page.click('#flipButton');
        await page.waitForTimeout(3000);
        const flippedPrice = (await page.textContent('#currentPrice')).trim();
        console.log(`  ${flippedPrice}`);
        check('切换基准后价格重算', flippedPrice.includes('='));
    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n═══ 浏览器端 通过 ${pass} · 失败 ${fail} ═══`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('未捕获异常:', e); process.exit(1); });
