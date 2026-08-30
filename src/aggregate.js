/**
 * 多池聚合
 *
 * 单个池子的答案是偏低的：把一个池推到目标价，套利会立刻从别的池把价格拉回来。
 * 真实成本是把**所有场地**都推到同一个价格所需资金的总和。
 *
 * 做法：
 *   1. 枚举工厂，找出这个 token 的所有 V2 / V3 池；V4 再扫一遍 Initialize 事件
 *   2. 先廉价地读一遍深度，把灰尘池筛掉，剩下的按深度排序
 *   3. 每个池各自求解到「同一个目标美元价」——注意各池报价币不同，
 *      目标价要按各自报价币的美元价换算
 *   4. 把各池所需资金折成美元后相加
 *
 * 所有读取共用同一个区块快照，横向加总才有意义。
 */
(function (root) {
    'use strict';

    const Rpc = root.Rpc;
    const Pricing = root.Pricing;
    const PoolAdapters = root.PoolAdapters;

    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

    const SEL = {
        getPair: '0xe6a43905',
        getPool: '0x1698ee82',
        getReserves: '0x0902f1ac',
        liquidity: '0x1a686502',
        token0: '0x0dfe1681',
        token1: '0xd21220a7'
    };

    // BSC 上常见的报价币，用来跟目标 token 配对找池子
    const QUOTE_TOKENS = [
        { addr: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB' },
        { addr: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT' },
        { addr: '0xe9e7cea3dedca5984780bafc599bd69add087d56', symbol: 'BUSD' },
        { addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC' },
        { addr: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', symbol: 'DAI' },
        { addr: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'BTCB' },
        { addr: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', symbol: 'ETH' },
        { addr: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', symbol: 'CAKE' }
    ];

    // 均已在链上核对有代码
    const V2_FACTORIES = [
        { name: 'PancakeSwap V2', addr: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', feePips: 2500 },
        { name: 'Uniswap V2', addr: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', feePips: 3000 },
        { name: 'Biswap V2', addr: '0x858e3312ed3a876947ea49d572a7c42de08af7ee', feePips: 1000 }
    ];

    const V3_FACTORIES = [
        { name: 'PancakeSwap V3', addr: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', fees: [100, 500, 2500, 10000] },
        { name: 'Uniswap V3', addr: '0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7', fees: [100, 500, 3000, 10000] }
    ];

    const DEFAULTS = {
        minDepthUsd: 2000,    // 报价币一侧不足这个金额的池子直接跳过
        maxPools: 14,         // 最多真正求解多少个池子
        v4Windows: 4          // V4 扫最近几个 getLogs 窗口
    };

    /** 枚举工厂，找出含该 token 的候选池 */
    async function discoverPools(rpc, tokenAddress, blockTag, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        const token = String(tokenAddress).toLowerCase();
        const quotes = QUOTE_TOKENS.filter(q => q.addr !== token);
        const calls = [];
        const meta = [];

        for (const f of V2_FACTORIES) {
            for (const q of quotes) {
                calls.push({
                    to: f.addr,
                    data: SEL.getPair + Rpc.encAddress(token) + Rpc.encAddress(q.addr)
                });
                meta.push({ kind: 'v2', factory: f.name, feePips: f.feePips, quote: q });
            }
        }
        for (const f of V3_FACTORIES) {
            for (const q of quotes) {
                for (const fee of f.fees) {
                    calls.push({
                        to: f.addr,
                        data: SEL.getPool + Rpc.encAddress(token) + Rpc.encAddress(q.addr) + Rpc.encUint(fee)
                    });
                    meta.push({ kind: 'v3', factory: f.name, fee: fee, quote: q });
                }
            }
        }

        const res = await rpc.batchCall(calls, blockTag);
        const found = [];
        const seen = new Set();
        res.forEach((r, i) => {
            if (!r) return;
            const addr = Rpc.wordToAddress(Rpc.words(r)[0]).toLowerCase();
            if (addr === ZERO_ADDR || seen.has(addr)) return;
            seen.add(addr);
            found.push(Object.assign({ address: addr }, meta[i]));
        });

        // V4 没有工厂可枚举，只能扫 Initialize 事件（受 getLogs 区块上限限制，只能尽力而为）
        if (o.v4Windows > 0) {
            try {
                const v4 = await discoverV4Pools(rpc, token, blockTag, o.v4Windows);
                for (const p of v4) {
                    if (seen.has(p.poolId)) continue;
                    seen.add(p.poolId);
                    found.push(p);
                }
            } catch (e) {
                // V4 扫不到不影响 V2/V3 的结果
            }
        }

        return found;
    }

    async function discoverV4Pools(rpc, token, blockTag, windows) {
        const V4 = PoolAdapters.V4;
        const latest = Number(BigInt(blockTag));
        const span = 4900;
        const out = [];
        for (let i = 0; i < windows; i++) {
            const hi = latest - i * span;
            const lo = Math.max(0, hi - span);
            let logs;
            try {
                logs = await rpc.getLogs({
                    address: V4.poolManager,
                    topics: [V4.initializeTopic],
                    fromBlock: '0x' + lo.toString(16),
                    toBlock: '0x' + hi.toString(16)
                });
            } catch (e) { continue; }
            for (const l of logs || []) {
                const c0 = ('0x' + l.topics[2].slice(26)).toLowerCase();
                const c1 = ('0x' + l.topics[3].slice(26)).toLowerCase();
                if (c0 !== token && c1 !== token) continue;
                const d = l.data.replace(/^0x/, '');
                const other = c0 === token ? c1 : c0;
                out.push({
                    kind: 'v4',
                    factory: 'Uniswap V4',
                    poolId: l.topics[1].toLowerCase(),
                    poolKey: {
                        currency0: c0, currency1: c1,
                        fee: Number(BigInt('0x' + d.slice(0, 64))),
                        tickSpacing: Number(Rpc.wordToSigned(d.slice(64, 128), 24)),
                        hooks: '0x' + d.slice(128, 192).slice(24)
                    },
                    quote: { addr: other, symbol: '?' }
                });
            }
        }
        return out;
    }

    /**
     * 廉价地量一遍深度，把灰尘池筛掉。
     * V2 直接读储备；V3/V4 读活跃流动性（只用于排序，不是精确的美元深度）。
     */
    async function measureDepth(rpc, pools, blockTag, quoteUsd) {
        const calls = [];
        const idx = [];
        pools.forEach((p, i) => {
            if (p.kind === 'v2') {
                calls.push({ to: p.address, data: SEL.getReserves });
                calls.push({ to: p.address, data: SEL.token0 });
                idx.push({ i, n: 2 });
            } else if (p.kind === 'v3') {
                calls.push({ to: p.address, data: SEL.liquidity });
                idx.push({ i, n: 1 });
            } else {
                calls.push({
                    to: PoolAdapters.V4.stateView,
                    data: '0xfa6793d5' + p.poolId.slice(2)
                });
                idx.push({ i, n: 1 });
            }
        });

        const res = await rpc.batchCall(calls, blockTag);
        let cursor = 0;
        for (const entry of idx) {
            const p = pools[entry.i];
            const slice = res.slice(cursor, cursor + entry.n);
            cursor += entry.n;

            if (p.kind === 'v2') {
                if (!slice[0] || !slice[1]) { p.depth = 0; continue; }
                const w = Rpc.words(slice[0]);
                const t0 = Rpc.wordToAddress(Rpc.words(slice[1])[0]).toLowerCase();
                // 报价币在哪一侧就取哪一侧的储备
                const quoteIsToken0 = t0 === p.quote.addr;
                const raw = Rpc.wordToBigInt(quoteIsToken0 ? w[0] : w[1]);
                const usd = quoteUsd[p.quote.addr];
                // decimals 这里还不知道，先按 18 估；只用于排序和筛灰尘，不影响最终结果
                p.depth = usd ? (Number(raw) / 1e18) * usd : Number(raw) / 1e18;
            } else {
                if (!slice[0]) { p.depth = 0; continue; }
                const L = Rpc.wordToBigInt(Rpc.words(slice[0])[0]);
                p.liquidity = L;
                // L 不是美元深度，只作为同类池之间的排序依据
                p.depth = L > 0n ? Number(L) / 1e18 : 0;
            }
        }
        return pools;
    }

    /**
     * 把该 token 的所有池子都推到同一个目标美元价，求总资金
     *
     * @param rpcUrl
     * @param baseToken       { address, symbol, decimals, totalSupply }
     * @param targetUsdPrice  目标美元价（= 目标市值 / 总供应量）
     * @param opts            { onProgress, minDepthUsd, maxPools, v4Windows, rpc, blockTag }
     */
    async function aggregate(rpcUrl, baseToken, targetUsdPrice, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        const report = o.onProgress || function () {};
        const rpc = o.rpc || new Rpc.RpcClient(rpcUrl);
        const token = String(baseToken.address).toLowerCase();

        // 发现阶段（尤其是 V4 扫 Initialize 事件）可能要几十秒。
        // 工厂映射基本不变，所以这一步用 latest 就行；等发现完再取区块快照，
        // 这样后面所有求解读到的状态既互相一致、又不会因为公共 RPC 不保留太旧的
        // 状态而在活跃池子上读到前后矛盾的数据。
        report('正在枚举工厂…');
        let pools = await discoverPools(rpc, token, 'latest', o);

        const blockTag = o.blockTag || await rpc.blockNumber();
        if (!pools.length) {
            return { blockTag, rows: [], totalUsd: 0, scanned: 0, note: '没有在已配置的工厂里找到任何池子' };
        }

        // 报价币的美元价（去重后一次算清）
        report(`找到 ${pools.length} 个候选池，正在给报价币定价…`);
        const quoteAddrs = [...new Set(pools.map(p => p.quote.addr))];
        const quoteUsd = {};
        for (const qa of quoteAddrs) {
            try {
                const r = await Pricing.resolveTokenUsdPrice(rpc, qa, '', blockTag);
                if (r && r.price > 0) quoteUsd[qa] = r.price;
            } catch (e) { /* 定不出价的报价币后面会被跳过 */ }
        }

        report('正在测量各池深度…');
        await measureDepth(rpc, pools, blockTag, quoteUsd);

        // 报价币定不出美元价的池子没法折算，直接排除
        pools = pools.filter(p => quoteUsd[p.quote.addr] !== undefined);
        pools.sort((a, b) => b.depth - a.depth);

        const candidates = pools.filter(p => p.depth > 0).slice(0, o.maxPools);
        const rows = [];
        let totalUsd = 0;
        let skipped = pools.length - candidates.length;

        for (let i = 0; i < candidates.length; i++) {
            const p = candidates[i];
            report(`正在求解第 ${i + 1}/${candidates.length} 个池子…`);
            try {
                const ad = await PoolAdapters.createAdapter(rpcUrl, p.kind === 'v4' ? p.poolId : p.address, {
                    rpc: rpc, blockTag: blockTag,
                    poolKey: p.poolKey,
                    v2FeePips: p.feePips
                });

                const t0 = String(ad.token0Info.address).toLowerCase();
                const baseIsToken0 = t0 === token;
                const quoteInfo = baseIsToken0 ? ad.token1Info : ad.token0Info;
                const qUsd = quoteUsd[String(quoteInfo.address).toLowerCase()];
                if (!qUsd) { skipped++; continue; }

                // 目标价换算到这个池自己的口径（adapter 始终是「1 token0 = ? token1」）
                const baseInQuote = targetUsdPrice / qUsd;
                const adapterTarget = baseIsToken0 ? baseInQuote : 1 / baseInQuote;

                const spot = ad.spotPrice();
                const spotBaseUsd = (baseIsToken0 ? spot : 1 / spot) * qUsd;

                const r = await ad.solveToPrice(adapterTarget);
                if (!r || !r.ok) { skipped++; continue; }

                // 资金流折成美元：输入侧是报价币就是流入，否则是流出
                const inIsQuote = String(r.tokenInAddress).toLowerCase()
                    === String(quoteInfo.address).toLowerCase();
                const quoteFlow = inIsQuote ? r.amountIn : -r.amountOut;
                const usd = quoteFlow * qUsd;

                if (r.reached && !r.exhausted && isFinite(usd)) totalUsd += usd;

                rows.push({
                    kind: p.kind,
                    factory: p.factory,
                    address: p.kind === 'v4' ? p.poolId : p.address,
                    pair: `${ad.token0Info.symbol}/${ad.token1Info.symbol}`,
                    quoteSymbol: quoteInfo.symbol,
                    quoteUsd: qUsd,
                    fee: r.feePips,
                    spotBaseUsd: spotBaseUsd,
                    quoteFlow: quoteFlow,
                    usd: usd,
                    ticksCrossed: r.ticksCrossed,
                    reached: r.reached,
                    exhausted: r.exhausted,
                    incomplete: r.incomplete,
                    hasHooks: !!r.hasHooks,
                    counted: r.reached && !r.exhausted && isFinite(usd)
                });
            } catch (e) {
                rows.push({
                    kind: p.kind, factory: p.factory,
                    address: p.kind === 'v4' ? p.poolId : p.address,
                    error: e.message, counted: false
                });
            }
        }

        rows.sort((a, b) => Math.abs(b.usd || 0) - Math.abs(a.usd || 0));
        return {
            blockTag, rows, totalUsd,
            scanned: pools.length,
            solved: rows.length,
            skipped: skipped,
            targetUsdPrice
        };
    }

    root.Aggregate = {
        aggregate,
        discoverPools,
        measureDepth,
        QUOTE_TOKENS, V2_FACTORIES, V3_FACTORIES, DEFAULTS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
