/**
 * 报价币的美元定价
 *
 * 顺序：稳定币 → WBNB → 通过 Pancake V2 工厂找 token/稳定币 池 → 找 token/WBNB 池。
 * 原来这段是用 web3 写的，现在改用自带的 Rpc 层，页面就不再需要任何 CDN 依赖了。
 */
(function (root) {
    'use strict';

    const Rpc = root.Rpc;

    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const WBNB_PRICE_POOL = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae';   // WBNB/BUSD
    const PANCAKE_V2_FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';

    const STABLES = {
        '0x55d398326f99059ff775485246999027b3197955': 'USDT',
        '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
        '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
        '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'DAI'
    };

    const SEL = {
        getReserves: '0x0902f1ac',
        token0: '0x0dfe1681',
        token1: '0xd21220a7',
        decimals: '0x313ce567',
        symbol: '0x95d89b41',
        getPair: '0xe6a43905'
    };

    /** 读一个 V2 池，返回 tokenAddress 以另一个 token 计价的价格（已做 decimals 换算） */
    async function getTokenPriceInPair(rpc, pairAddress, tokenAddress, blockTag) {
        const head = await rpc.batchCall([
            { to: pairAddress, data: SEL.getReserves },
            { to: pairAddress, data: SEL.token0 },
            { to: pairAddress, data: SEL.token1 }
        ], blockTag);
        if (!head[0] || !head[1] || !head[2]) return null;

        const res = Rpc.words(head[0]);
        const t0 = Rpc.wordToAddress(Rpc.words(head[1])[0]);
        const t1 = Rpc.wordToAddress(Rpc.words(head[2])[0]);

        const meta = await rpc.batchCall([
            { to: t0, data: SEL.decimals },
            { to: t1, data: SEL.decimals },
            { to: t0, data: SEL.symbol },
            { to: t1, data: SEL.symbol }
        ], blockTag);
        if (!meta[0] || !meta[1]) return null;

        const d0 = Number(Rpc.wordToBigInt(Rpc.words(meta[0])[0]));
        const d1 = Number(Rpc.wordToBigInt(Rpc.words(meta[1])[0]));
        const r0 = Number(Rpc.wordToBigInt(res[0])) / Math.pow(10, d0);
        const r1 = Number(Rpc.wordToBigInt(res[1])) / Math.pow(10, d1);
        if (!(r0 > 0) || !(r1 > 0)) return null;

        const target = String(tokenAddress).toLowerCase();
        if (target === t0.toLowerCase()) {
            return { price: r1 / r0, otherSymbol: Rpc.decodeString(meta[3]), otherReserve: r1 };
        }
        if (target === t1.toLowerCase()) {
            return { price: r0 / r1, otherSymbol: Rpc.decodeString(meta[2]), otherReserve: r0 };
        }
        return null;
    }

    async function getWbnbUsdPrice(rpc, blockTag) {
        const r = await getTokenPriceInPair(rpc, WBNB_PRICE_POOL, WBNB, blockTag);
        if (!r) throw new Error('WBNB 价格池读取失败');
        return r.price;
    }

    /** 给某个 token 定美元价，定不出来返回 null */
    async function resolveTokenUsdPrice(rpc, tokenAddress, tokenSymbol, blockTag) {
        const addr = String(tokenAddress).toLowerCase();

        if (addr === ZERO_ADDR) {
            return { price: await getWbnbUsdPrice(rpc, blockTag), source: '原生 BNB（按 WBNB 价）' };
        }
        if (STABLES[addr]) {
            return { price: 1.0, source: `稳定币 ${STABLES[addr]}` };
        }
        if (addr === WBNB) {
            return { price: await getWbnbUsdPrice(rpc, blockTag), source: 'WBNB 价格池' };
        }

        // token / 稳定币
        const stableAddrs = Object.keys(STABLES);
        const pairCalls = stableAddrs.map(s => ({
            to: PANCAKE_V2_FACTORY,
            data: SEL.getPair + Rpc.encAddress(addr) + Rpc.encAddress(s)
        }));
        const pairRes = await rpc.batchCall(pairCalls, blockTag);

        for (let i = 0; i < stableAddrs.length; i++) {
            if (!pairRes[i]) continue;
            const pair = Rpc.wordToAddress(Rpc.words(pairRes[i])[0]);
            if (pair.toLowerCase() === ZERO_ADDR) continue;
            const r = await getTokenPriceInPair(rpc, pair, addr, blockTag);
            // 稳定币储备太小的池子不可信
            if (r && r.otherReserve >= 100) {
                return { price: r.price, source: `${tokenSymbol}/${STABLES[stableAddrs[i]]} 池 (${pair})` };
            }
        }

        // token / WBNB
        const wbnbPairRes = await rpc.call(
            PANCAKE_V2_FACTORY, SEL.getPair + Rpc.encAddress(addr) + Rpc.encAddress(WBNB), blockTag);
        if (wbnbPairRes) {
            const pair = Rpc.wordToAddress(Rpc.words(wbnbPairRes)[0]);
            if (pair.toLowerCase() !== ZERO_ADDR) {
                const r = await getTokenPriceInPair(rpc, pair, addr, blockTag);
                if (r && r.otherReserve >= 0.1) {
                    const wbnbUsd = await getWbnbUsdPrice(rpc, blockTag);
                    return {
                        price: r.price * wbnbUsd,
                        source: `${tokenSymbol}/WBNB 池 (${pair}) × WBNB 美元价`
                    };
                }
            }
        }

        return null;
    }

    root.Pricing = {
        getTokenPriceInPair,
        getWbnbUsdPrice,
        resolveTokenUsdPrice,
        STABLES, WBNB, PANCAKE_V2_FACTORY, ZERO_ADDR
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
