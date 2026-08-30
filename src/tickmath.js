/**
 * TickMath —— Uniswap V3 / V4 tick 与 sqrtPriceX96 的互转（全 BigInt）
 *
 * V3 和 V4 用的是同一套 tick 定义，所以这个模块两边共用。
 * 常量取自 Uniswap V3 core 的 TickMath.sol。
 */
(function (root) {
    'use strict';

    const Q96 = 1n << 96n;
    const Q128 = 1n << 128n;
    const MAX_UINT256 = (1n << 256n) - 1n;

    const MIN_TICK = -887272;
    const MAX_TICK = 887272;
    const MIN_SQRT_RATIO = 4295128739n;
    const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

    // getSqrtRatioAtTick 的逐位乘数表：第 i 项对应 absTick 的第 i 个二进制位
    const MAGIC = [
        0xfffcb933bd6fad37aa2d162d1a594001n,
        0xfff97272373d413259a46990580e213an,
        0xfff2e50f5f656932ef12357cf3c7fdccn,
        0xffe5caca7e10e4e61c3624eaa0941cd0n,
        0xffcb9843d60f6159c9db58835c926644n,
        0xff973b41fa98c081472e6896dfb254c0n,
        0xff2ea16466c96a3843ec78b326b52861n,
        0xfe5dee046a99a2a811c461f1969c3053n,
        0xfcbe86c7900a88aedcffc83b479aa3a4n,
        0xf987a7253ac413176f2b074cf7815e54n,
        0xf3392b0822b70005940c7a398e4b70f3n,
        0xe7159475a2c29b7443b29c7fa6e889d9n,
        0xd097f3bdfd2022b8845ad8f792aa5825n,
        0xa9f746462d870fdf8a65dc1f90e061e5n,
        0x70d869a156d2a1b890bb3df62baf32f7n,
        0x31be135f97d08fd981231505542fcfa6n,
        0x9aa508b5b7a84e1c677de54f3e99bc9n,
        0x5d6af8dedb81196699c329225ee604n,
        0x2216e584f5fa1ea926041bedfe98n,
        0x48a170391f7dc42444e8fa2n
    ];

    /** tick -> sqrtPriceX96（Q64.96 定点） */
    function getSqrtRatioAtTick(tick) {
        const t = Number(tick) | 0;
        if (t < MIN_TICK || t > MAX_TICK) {
            throw new Error('TickMath: tick 越界 ' + t);
        }
        const absTick = t < 0 ? -t : t;

        // ratio 是 Q128.128
        let ratio = (absTick & 0x1) !== 0 ? MAGIC[0] : Q128;
        for (let i = 1; i < MAGIC.length; i++) {
            if ((absTick & (1 << i)) !== 0) {
                ratio = (ratio * MAGIC[i]) >> 128n;
            }
        }

        if (t > 0) ratio = MAX_UINT256 / ratio;

        // Q128.128 -> Q64.96，向上取整（与 Solidity 实现一致）
        const shifted = ratio >> 32n;
        return (ratio % (1n << 32n)) === 0n ? shifted : shifted + 1n;
    }

    /**
     * sqrtPriceX96 -> tick
     *
     * 用二分查找而不是移植 Solidity 里那段 log2 汇编：迭代 21 次左右就能收敛，
     * 代价可以忽略，但少了一整块极易抄错的位运算。
     * 返回满足 getSqrtRatioAtTick(tick) <= sqrtPriceX96 的最大 tick，与 Solidity 语义一致。
     */
    function getTickAtSqrtRatio(sqrtPriceX96) {
        const sp = BigInt(sqrtPriceX96);
        if (sp < MIN_SQRT_RATIO || sp >= MAX_SQRT_RATIO) {
            throw new Error('TickMath: sqrtPriceX96 越界 ' + sp.toString());
        }
        let lo = MIN_TICK;
        let hi = MAX_TICK;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (getSqrtRatioAtTick(mid) <= sp) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /**
     * 人类可读价格 -> sqrtPriceX96
     * price 指「1 个 token0 值多少 token1」，已按 decimals 调整过。
     */
    function priceToSqrtRatioX96(price, decimals0, decimals1) {
        if (!(price > 0) || !isFinite(price)) throw new Error('TickMath: 价格必须为正有限数');
        // 链上裸比值 = price * 10^(d1 - d0)
        const raw = price * Math.pow(10, Number(decimals1) - Number(decimals0));
        if (!isFinite(raw) || raw <= 0) throw new Error('TickMath: 价格换算后溢出');

        // 先用浮点求 sqrt 得到近似 tick，再在附近做一次精修，避免大指数下的浮点误差
        const approx = Math.sqrt(raw) * 2 ** 96;
        let sp;
        if (isFinite(approx) && approx > 0) {
            sp = BigInt(Math.round(approx));
        } else {
            // 极端价格：退化到用 tick 逼近
            const tick = Math.round(Math.log(raw) / Math.log(1.0001));
            sp = getSqrtRatioAtTick(Math.max(MIN_TICK, Math.min(MAX_TICK, tick)));
        }
        if (sp < MIN_SQRT_RATIO) sp = MIN_SQRT_RATIO;
        if (sp >= MAX_SQRT_RATIO) sp = MAX_SQRT_RATIO - 1n;
        return sp;
    }

    /** sqrtPriceX96 -> 人类可读价格（1 token0 = ? token1） */
    function sqrtRatioX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
        const sp = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
        return sp * sp * Math.pow(10, Number(decimals0) - Number(decimals1));
    }

    root.TickMath = {
        Q96, Q128, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO,
        getSqrtRatioAtTick,
        getTickAtSqrtRatio,
        priceToSqrtRatioX96,
        sqrtRatioX96ToPrice
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
