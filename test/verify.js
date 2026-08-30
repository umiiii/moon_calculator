/**
 * 求解器验证脚本（Node 18+，需要联网）
 *
 *   node test/verify.js
 *
 * 核心验证思路：把求解器算出的 amountIn 原样喂给 PancakeSwap V3 官方 QuoterV2，
 * 让链上真实的 swap 模拟跑一遍，看它落到的 sqrtPriceX96After 是不是我们的目标价。
 * 对得上，说明跨 tick 行走的数学是对的。
 */
'use strict';

require('../src/tickmath.js');
require('../src/rpc.js');
require('../src/clsolver.js');
require('../src/adapters.js');

const { TickMath, Rpc, PoolAdapters } = globalThis;

const RPC_URL = process.env.RPC_URL || 'https://rpc-bsc.48.club';

const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const SEL_GET_POOL = '0x1698ee82';
const SEL_QUOTE_EXACT_IN_SINGLE = '0xc6a5026a';

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const BTCB = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';

// keccak256：Node 里没有 web3，用一份最小实现注入给 adapters
require('../src/keccak.js');   // 挂到 globalThis.Keccak，adapters 会自动用上

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(label, ok, detail) {
    (ok ? pass++ : fail++);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

async function findPool(rpc, a, b, fee, blockTag) {
    const data = SEL_GET_POOL + Rpc.encAddress(a) + Rpc.encAddress(b) + Rpc.encUint(fee);
    const res = await rpc.call(PANCAKE_V3_FACTORY, data, blockTag);
    if (!res) return null;
    const addr = Rpc.wordToAddress(Rpc.words(res)[0]);
    return addr === PoolAdapters.ZERO_ADDR ? null : addr;
}

/** 调 QuoterV2 做一次真实 swap 模拟 */
async function quote(rpc, tokenIn, tokenOut, amountInRaw, fee, blockTag) {
    const data = SEL_QUOTE_EXACT_IN_SINGLE
        + Rpc.encAddress(tokenIn)
        + Rpc.encAddress(tokenOut)
        + Rpc.encUint(amountInRaw)
        + Rpc.encUint(fee)
        + Rpc.encUint(0);            // sqrtPriceLimitX96 = 0 表示不设限
    const res = await rpc.call(PANCAKE_V3_QUOTER, data, blockTag);
    if (!res || res === '0x') return null;
    const w = Rpc.words(res);
    return {
        amountOut: Rpc.wordToBigInt(w[0]),
        sqrtPriceX96After: Rpc.wordToBigInt(w[1]),
        ticksCrossed: Number(Rpc.wordToBigInt(w[2]))
    };
}

async function verifyV3Pool(label, tokenA, tokenB, fee) {
    console.log(`\n── V3 ${label} (fee ${fee}) ───────────────────────────────`);
    const rpc = new Rpc.RpcClient(RPC_URL);
    const blockTag = await rpc.blockNumber();
    const pool = await findPool(rpc, tokenA, tokenB, fee, blockTag);
    if (!pool) { console.log('  跳过：工厂里没有这个池子'); return; }

    const ad = await PoolAdapters.createAdapter(RPC_URL, pool, {});
    if (ad.kind !== 'v3') { console.log('  跳过：识别成了 ' + ad.kind); return; }

    const spot = ad.spotPrice();
    console.log(`  池子 ${pool}`);
    console.log(`  ${ad.token0Info.symbol}/${ad.token1Info.symbol}  `
        + `spacing=${ad.state.tickSpacing} fee=${ad.state.feePips} L=${ad.state.liquidity}`);
    console.log(`  现价 1 ${ad.token0Info.symbol} = ${spot.toPrecision(8)} ${ad.token1Info.symbol}`);

    const d0 = ad.token0Info.decimals, d1 = ad.token1Info.decimals;

    for (const mult of [1.005, 1.02, 1.10, 0.995, 0.98, 0.90]) {
        await sleep(700);   // 给公共 RPC 留点余地，否则会被 429
        const targetPrice = spot * mult;
        const r = await ad.solveToPrice(targetPrice);
        if (!r.ok || !r.reached) {
            check(`${((mult - 1) * 100).toFixed(1)}%`, false,
                `求解未到达 (reached=${r.reached} exhausted=${r.exhausted} outOfRange=${r.outOfRange})`);
            continue;
        }

        const up = r.direction === 'in';
        const tokenIn = up ? ad.token1Info : ad.token0Info;
        const tokenOut = up ? ad.token0Info : ad.token1Info;
        const amountInRaw = BigInt(Math.floor(r.amountIn * Math.pow(10, tokenIn.decimals)));
        if (amountInRaw <= 0n) { check(`${((mult - 1) * 100).toFixed(1)}%`, false, 'amountIn 为 0'); continue; }

        const q = await quote(rpc, tokenIn.address, tokenOut.address, amountInRaw, ad.state.feePips, blockTag);
        if (!q) { check(`${((mult - 1) * 100).toFixed(1)}%`, false, 'QuoterV2 调用失败'); continue; }

        // 把求解器的目标价换算成链上 sqrt 值，和 Quoter 实际到达的价格比
        const wantSqrt = TickMath.priceToSqrtRatioX96(targetPrice, d0, d1);
        const gotSqrt = q.sqrtPriceX96After;
        const relPrice = Math.abs(Number(gotSqrt - wantSqrt) / Number(wantSqrt)) * 2; // sqrt -> price 误差翻倍

        const ourOut = BigInt(Math.floor(r.amountOut * Math.pow(10, tokenOut.decimals)));
        const relOut = Number(q.amountOut) > 0
            ? Math.abs(Number(ourOut - q.amountOut) / Number(q.amountOut)) : 0;

        const ok = relPrice < 1e-4 && relOut < 1e-3;
        check(
            `${((mult - 1) * 100).toFixed(1).padStart(5)}%  ${up ? '流入' : '流出'} ` +
            `${r.amountIn.toPrecision(7)} ${tokenIn.symbol}`,
            ok,
            `价格误差 ${(relPrice * 100).toExponential(2)}%  产出误差 ${(relOut * 100).toExponential(2)}%  ` +
            `tick跨越 我们=${r.ticksCrossed} quoter=${q.ticksCrossed}`
        );
    }
}

const V4_QUOTER = '0x9f75dd27d6664c475b90e105573e550ff69437b0';
const SEL_V4_QUOTE = '0xaa9d21cb';   // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
const V4_POOL_MANAGER = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
const V4_INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

/** 调 Uniswap V4Quoter 做一次真实 swap 模拟，返回 amountOut */
async function quoteV4(rpc, poolKey, zeroForOne, exactAmountRaw, blockTag) {
    const data = SEL_V4_QUOTE
        + Rpc.encUint(0x20)                     // 结构体是动态的（含 bytes），先给偏移
        + Rpc.encAddress(poolKey.currency0)
        + Rpc.encAddress(poolKey.currency1)
        + Rpc.encUint(poolKey.fee)
        + Rpc.encInt(poolKey.tickSpacing)
        + Rpc.encAddress(poolKey.hooks)
        + Rpc.encUint(zeroForOne ? 1 : 0)
        + Rpc.encUint(exactAmountRaw)
        + Rpc.encUint(0x100)                    // hookData 相对结构体起点的偏移
        + Rpc.encUint(0);                       // hookData 长度 = 0
    const res = await rpc.call(V4_QUOTER, data, blockTag);
    if (!res || res === '0x') return null;
    return { amountOut: Rpc.wordToBigInt(Rpc.words(res)[0]) };
}

/** 扫最近的 Initialize 事件，挑一个当前真的有流动性的无 hook 池 */
async function findLiveV4Pool(rpc, blockTag) {
    const latest = Number(BigInt(blockTag));
    const found = new Map();
    for (let i = 0; i < 6 && found.size < 60; i++) {
        const hi = latest - i * 4900, lo = hi - 4900;
        let logs;
        try {
            logs = await rpc.getLogs({
                address: V4_POOL_MANAGER, topics: [V4_INIT_TOPIC],
                fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16)
            });
        } catch (e) { continue; }
        for (const l of logs || []) {
            const d = l.data.replace(/^0x/, '');
            const hooks = '0x' + d.slice(128, 192).slice(24);
            if (hooks !== PoolAdapters.ZERO_ADDR) continue;   // 带 hook 的池数学不通用，跳过
            found.set(l.topics[1], {
                poolId: l.topics[1],
                currency0: '0x' + l.topics[2].slice(26),
                currency1: '0x' + l.topics[3].slice(26),
                fee: Number(BigInt('0x' + d.slice(0, 64))),
                tickSpacing: Number(Rpc.wordToSigned(d.slice(64, 128), 24)),
                hooks: hooks
            });
        }
        await sleep(250);
    }
    const ids = [...found.keys()];
    if (!ids.length) return null;
    const res = await rpc.batchCall(
        ids.map(id => ({ to: PoolAdapters.V4.stateView, data: '0xfa6793d5' + id.slice(2) })), blockTag);
    let best = null, bestL = 0n;
    ids.forEach((id, i) => {
        if (!res[i]) return;
        const L = Rpc.wordToBigInt(Rpc.words(res[i])[0]);
        if (L > bestL) { bestL = L; best = found.get(id); }
    });
    return best ? { key: best, liquidity: bestL } : null;
}

async function verifyV4() {
    console.log('\n\u2500\u2500 V4 (Uniswap V4 on BSC) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    const rpc = new Rpc.RpcClient(RPC_URL);

    // 先扫日志找池子（这一步要几十秒），扫完再取区块快照。
    // 否则等求解跑起来时，公共 RPC 对这个已经偏旧的区块可能给不出一致的状态，
    // 在活跃池子上会表现为莫名其妙的偏差。
    const live = await findLiveV4Pool(rpc, await rpc.blockNumber());
    if (!live) { console.log('  跳过：最近区块里没找到有流动性的无 hook V4 池'); return; }

    const blockTag = await rpc.blockNumber();

    const key = live.key;
    const computed = PoolAdapters.computePoolId(key).toLowerCase();
    check('poolId = keccak256(abi.encode(PoolKey))', computed === key.poolId.toLowerCase(),
        computed === key.poolId.toLowerCase() ? '' : `\u7b97\u51fa ${computed} / \u94fe\u4e0a ${key.poolId}`);

    const ad = await PoolAdapters.createAdapter(RPC_URL, key.poolId, { poolKey: key });
    const spot = ad.spotPrice();
    console.log(`  ${ad.token0Info.symbol}/${ad.token1Info.symbol}  fee=${key.fee} spacing=${key.tickSpacing}`);
    console.log(`  lpFee=${ad.state.lpFee} protocolFee=${ad.state.protocolFee} L=${ad.state.liquidity}`);
    console.log(`  \u73b0\u4ef7 1 ${ad.token0Info.symbol} = ${spot.toPrecision(8)} ${ad.token1Info.symbol}`);
    check('V4 状态读取（slot0 + liquidity）', ad.state.sqrtPriceX96 > 0n && ad.state.liquidity > 0n,
        `L=${ad.state.liquidity}`);

    for (const mult of [1.02, 0.98]) {
        await sleep(700);
        const target = spot * mult;
        const r = await ad.solveToPrice(target);
        if (!r.ok || !r.reached || !(r.amountIn > 0)) {
            check(`${((mult - 1) * 100).toFixed(1)}%`, false,
                `reached=${r.reached} exhausted=${r.exhausted} amountIn=${r.amountIn}`);
            continue;
        }

        // 落点必须就是目标价
        const landed = Math.abs(r.priceAfter / target - 1);

        // 再拿 V4Quoter 真实模拟一遍，对比产出量
        const up = r.direction === 'in';
        const tokenIn = up ? ad.token1Info : ad.token0Info;
        const tokenOut = up ? ad.token0Info : ad.token1Info;
        const amountInRaw = BigInt(Math.floor(r.amountIn * Math.pow(10, tokenIn.decimals)));
        const q = await quoteV4(rpc, key, !up, amountInRaw, blockTag);   // zeroForOne = 卖出 token0 = 价格向下

        let detail = `落点误差 ${landed.toExponential(2)}  tick跨越=${r.ticksCrossed}`;
        let ok = landed < 1e-6;
        if (q && q.amountOut > 0n) {
            const ourOut = BigInt(Math.floor(r.amountOut * Math.pow(10, tokenOut.decimals)));
            const relOut = Math.abs(Number(ourOut - q.amountOut) / Number(q.amountOut));
            detail += `  V4Quoter 产出误差 ${(relOut * 100).toExponential(2)}%`;
            ok = ok && relOut < 1e-3;
        } else {
            detail += '  (V4Quoter 未返回，仅校验落点)';
        }

        check(`${((mult - 1) * 100).toFixed(1).padStart(5)}%  ${up ? '流入' : '流出'} ` +
            `${r.amountIn.toPrecision(7)} ${tokenIn.symbol}`, ok, detail);
    }
}

async function verifyV2() {
    console.log('\n── V2 (含手续费的精确解) ────────────────────────────────');
    const pool = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae'; // WBNB/BUSD
    try {
        const ad = await PoolAdapters.createAdapter(RPC_URL, pool, {});
        check('识别为 V2', ad.kind === 'v2', `实际 ${ad.kind}`);
        const spot = ad.spotPrice();
        console.log(`  ${ad.token0Info.symbol}/${ad.token1Info.symbol}  现价 ${spot.toPrecision(8)}`);

        for (const mult of [1.05, 0.95]) {
            const target = spot * mult;
            const r = await ad.solveToPrice(target);
            // 交易后现价必须精确等于目标价
            const err = Math.abs(r.priceAfter / target - 1);
            check(
                `${((mult - 1) * 100).toFixed(1).padStart(5)}%  ${r.direction === 'in' ? '流入' : '流出'} ` +
                `${r.amountIn.toPrecision(7)} ${r.tokenIn}`,
                err < 1e-9, `落点误差 ${err.toExponential(2)}`);
        }

        // 手续费必须让所需资金变多：f=0 的解应当严格小于 f=0.25% 的解
        const noFee = new PoolAdapters.V2Adapter(
            ad.rpc, ad.address, [ad.token0Info, ad.token1Info], [ad.reserve0, ad.reserve1], 0);
        const a = await ad.solveToPrice(spot * 1.05);
        const b = await noFee.solveToPrice(spot * 1.05);
        check('计费后所需资金 > 不计费', a.amountIn > b.amountIn,
            `${a.amountIn.toPrecision(8)} vs ${b.amountIn.toPrecision(8)}  ` +
            `(+${((a.amountIn / b.amountIn - 1) * 100).toFixed(4)}%)`);
    } catch (e) {
        check('V2 求解', false, e.message);
    }
}

(async () => {
    console.log('RPC:', RPC_URL);
    await verifyV2();
    await sleep(1000);
    await verifyV3Pool('WBNB/USDT', WBNB, USDT, 500);
    await sleep(1000);
    await verifyV3Pool('CAKE/WBNB', CAKE, WBNB, 2500);
    await sleep(1000);
    await verifyV4();
    console.log(`\n═══ 通过 ${pass} · 失败 ${fail} ═══`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n未捕获异常:', e); process.exit(1); });
