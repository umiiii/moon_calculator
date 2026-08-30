/**
 * 集中流动性求解器（V3 / V4 共用）
 *
 * 回答的问题：把池子价格从现价推到目标价，需要投入多少报价币？
 *
 * 做法是沿 tick 逐段积分。相邻两个已初始化 tick 之间流动性 L 恒定，此时：
 *     Δy = L · (√P_b − √P_a)              token1 数量
 *     Δx = L · (√P_b − √P_a) / (√P_a·√P_b) token0 数量
 * 每跨过一个已初始化 tick，L 按 liquidityNet 更新：向上 +，向下 −。
 *
 * 手续费：V3/V4 的手续费计入 feeGrowthGlobal，不进入 swap 曲线，价格路径与费率无关，
 * 所以把累加出的净输入量整体除以 (1 − f) 就是精确的含费输入量。
 *
 * 调用方需要提供一个 source，实现三个方法：
 *     loadState()                  -> { sqrtPriceX96, tick, liquidity, tickSpacing, feePips }
 *     loadBitmapWords(wordPosList) -> Map<wordPos, BigInt>
 *     loadTickLiquidityNet(ticks)  -> Map<tick, BigInt>
 */
(function (root) {
    'use strict';

    const TickMath = root.TickMath;
    const Q96 = 1n << 96n;

    // 单次求解最多扫描多少个位图字（1 个字 = 256 个 tickSpacing 间隔）
    const MAX_WORDS = 512;
    // 单次求解最多跨越多少个 tick，防止极端目标价把请求量放大到不可控
    const MAX_PATH_TICKS = 800;

    function floorDiv(a, b) {
        return Math.floor(a / b);
    }

    /** compressed tick -> 位图字号 / 位号 */
    function bitmapPosition(compressed) {
        return { wordPos: compressed >> 8, bitPos: compressed & 0xff };
    }

    /** 把一个位图字里置位的比特还原成实际 tick 列表 */
    function decodeWord(wordPos, value, tickSpacing) {
        const ticks = [];
        if (value === 0n) return ticks;
        for (let bit = 0; bit < 256; bit++) {
            if ((value >> BigInt(bit)) & 1n) {
                ticks.push((wordPos * 256 + bit) * tickSpacing);
            }
        }
        return ticks;
    }

    /**
     * 主求解入口
     * @param source  见文件头注释
     * @param sqrtTargetX96 目标 √价格（BigInt，链上裸值）
     * @param opts    { decimals0, decimals1 }
     */
    async function solveToSqrtPrice(source, sqrtTargetX96, opts) {
        const o = opts || {};
        const d0 = Number(o.decimals0 || 0);
        const d1 = Number(o.decimals1 || 0);

        const state = await source.loadState();
        let sp = BigInt(state.sqrtPriceX96);
        let L = BigInt(state.liquidity);
        const tickSpacing = Number(state.tickSpacing);
        const feePips = Number(state.feePips);
        const startSqrt = sp;

        let target = BigInt(sqrtTargetX96);
        if (target < TickMath.MIN_SQRT_RATIO) target = TickMath.MIN_SQRT_RATIO;
        if (target >= TickMath.MAX_SQRT_RATIO) target = TickMath.MAX_SQRT_RATIO - 1n;

        const up = target > sp;

        const result = {
            reached: false,
            exhausted: false,
            outOfRange: false,
            incomplete: false,
            direction: up ? 'in' : 'out',
            ticksCrossed: 0,
            steps: [],
            feePips: feePips
        };

        if (target === sp) {
            result.reached = true;
            result.amount0Raw = 0n;
            result.amount1Raw = 0n;
            return finalize(result, sp, startSqrt, 0n, 0n, feePips, up, d0, d1);
        }

        // ---- 1. 确定要扫描的位图字范围 ----
        const curTick = TickMath.getTickAtSqrtRatio(sp);
        const tgtTick = TickMath.getTickAtSqrtRatio(target);
        const curWord = bitmapPosition(floorDiv(curTick, tickSpacing)).wordPos;
        const tgtWord = bitmapPosition(floorDiv(tgtTick, tickSpacing)).wordPos;

        let loWord = Math.min(curWord, tgtWord);
        let hiWord = Math.max(curWord, tgtWord);
        // 多扫一个字，避免目标价正好落在字边界上时漏掉最后一个 tick
        loWord -= 1;
        hiWord += 1;
        if (hiWord - loWord + 1 > MAX_WORDS) {
            result.outOfRange = true;
            if (up) hiWord = loWord + MAX_WORDS - 1;
            else loWord = hiWord - MAX_WORDS + 1;
        }

        const wordList = [];
        for (let w = loWord; w <= hiWord; w++) wordList.push(w);

        // ---- 2. 批量拉位图，解出所有已初始化 tick ----
        const wordMap = await source.loadBitmapWords(wordList);
        if (wordMap.size < wordList.length) {
            result.incomplete = true;
            result.missingWords = wordList.length - wordMap.size;
        }
        let initTicks = [];
        for (const w of wordList) {
            const v = wordMap.get(w);
            if (v) initTicks = initTicks.concat(decodeWord(w, BigInt(v), tickSpacing));
        }
        initTicks.sort((a, b) => a - b);

        // 只保留真正会被跨过的 tick：行进方向上、且落在现价与目标价之间。
        // 目标价之外的 tick 永远走不到，把它们排除掉能把请求量从几百降到几十，
        // 既快得多也不会撞上 RPC 限流。
        let path = up
            ? initTicks.filter(t => {
                const s = TickMath.getSqrtRatioAtTick(t);
                return s > sp && s <= target;
            }).sort((a, b) => a - b)
            : initTicks.filter(t => {
                const s = TickMath.getSqrtRatioAtTick(t);
                return s <= sp && s >= target;
            }).sort((a, b) => b - a);

        if (path.length > MAX_PATH_TICKS) {
            path = path.slice(0, MAX_PATH_TICKS);
            result.outOfRange = true;
        }

        // ---- 3. 批量拉这些 tick 的 liquidityNet ----
        const netMap = await source.loadTickLiquidityNet(path);

        // 有 tick 没读回来就说明结果不完整，必须如实告诉调用方，
        // 否则会静默给出一个偏小的数字
        if (netMap.size < path.length) {
            result.incomplete = true;
            result.missingTicks = path.length - netMap.size;
        }

        // ---- 4. 在内存里走完整条路径 ----
        let amt0 = 0n;   // token0 累计（裸数量）
        let amt1 = 0n;   // token1 累计（裸数量）

        for (let i = 0; i < path.length; i++) {
            if (up ? sp >= target : sp <= target) break;

            const t = path[i];
            const sqrtAtTick = TickMath.getSqrtRatioAtTick(t);
            // 本段终点：下一个 tick 与目标价，谁先到取谁
            const segEnd = up
                ? (sqrtAtTick > target ? target : sqrtAtTick)
                : (sqrtAtTick < target ? target : sqrtAtTick);

            if (segEnd !== sp && L > 0n) {
                const lo = up ? sp : segEnd;
                const hi = up ? segEnd : sp;
                const dy = (L * (hi - lo)) / Q96;
                const dx = (L * Q96 * (hi - lo)) / (hi * lo);
                amt1 += dy;
                amt0 += dx;
                if (result.steps.length < 400) {
                    result.steps.push({ tick: t, liquidity: L, dx: dx, dy: dy });
                }
            }

            sp = segEnd;

            // 真的踩到这个 tick 才算跨过
            if (sp === sqrtAtTick) {
                const net = netMap.get(t);
                if (net !== undefined) {
                    L += up ? BigInt(net) : -BigInt(net);
                    if (L < 0n) L = 0n;
                }
                result.ticksCrossed++;
            }
        }

        // ---- 5. 收尾：最后一段 ----
        // path 只包含现价与目标价之间的 tick，所以走完之后 sp 通常还差最后一小段。
        // 这一段里已经没有已初始化 tick，L 恒定，直接一次算完即可。
        if (!result.outOfRange && (up ? sp < target : sp > target)) {
            if (L > 0n) {
                const lo = up ? sp : target;
                const hi = up ? target : sp;
                const dy = (L * (hi - lo)) / Q96;
                const dx = (L * Q96 * (hi - lo)) / (hi * lo);
                amt1 += dy;
                amt0 += dx;
                if (result.steps.length < 400) {
                    result.steps.push({ tick: null, liquidity: L, dx: dx, dy: dy });
                }
            }
            sp = target;
        }

        // ---- 6. 判定 ----
        result.reached = up ? sp >= target : sp <= target;
        if (!result.reached) {
            // 只可能是扫描范围被 MAX_WORDS / MAX_PATH_TICKS 截断
            result.outOfRange = true;
        } else if (L === 0n) {
            // 走到目标价时池内已经没有流动性了：这个价格可以被极小的资金推到，
            // 但会被套利立刻拉回，数字没有实际意义
            result.exhausted = true;
        }

        return finalize(result, sp, startSqrt, amt0, amt1, feePips, up, d0, d1);
    }

    function finalize(result, sp, startSqrt, amt0Raw, amt1Raw, feePips, up, d0, d1) {
        const pow0 = Math.pow(10, d0);
        const pow1 = Math.pow(10, d1);

        const amount0 = Number(amt0Raw) / pow0;
        const amount1 = Number(amt1Raw) / pow1;

        // 输入侧净量（未含手续费）
        const netIn = up ? amount1 : amount0;
        const out = up ? amount0 : amount1;

        const feeRate = feePips / 1e6;
        const grossIn = feeRate < 1 ? netIn / (1 - feeRate) : netIn;

        result.amount0Raw = amt0Raw;
        result.amount1Raw = amt1Raw;
        result.amount0 = amount0;
        result.amount1 = amount1;
        result.amountInNet = netIn;
        result.amountInGross = grossIn;
        result.amountOut = out;
        result.feePaid = grossIn - netIn;

        // 以 token1（报价币）为口径的资金流：正 = 净流入，负 = 净流出
        result.quoteFlow = up ? grossIn : -amount1;

        result.sqrtPriceAfterX96 = sp;
        result.priceAfter = TickMath.sqrtRatioX96ToPrice(sp, d0, d1);
        result.priceBefore = TickMath.sqrtRatioX96ToPrice(startSqrt, d0, d1);
        return result;
    }

    root.CLSolver = {
        solveToSqrtPrice,
        decodeWord,
        bitmapPosition,
        MAX_WORDS,
        MAX_PATH_TICKS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
