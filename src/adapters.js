/**
 * 池子适配器：V2 / V3 / V4 统一成同一个接口给上层调用
 *
 *   kind          'v2' | 'v3' | 'v4'
 *   token0Info    { address, name, symbol, decimals, totalSupply }
 *   token1Info    同上
 *   spotPrice()   1 个 token0 值多少 token1（已按 decimals 调整）
 *   solveToPrice(targetPrice) -> 归一化的求解结果
 *
 * V3 和 V4 的求解走同一个 CLSolver，区别只在 loadState / loadBitmapWords /
 * loadTickLiquidityNet 三个取数方法的实现。
 */
(function (root) {
    'use strict';

    const Rpc = root.Rpc;
    const TickMath = root.TickMath;
    const CLSolver = root.CLSolver;

    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

    // ---- 函数选择器 ----
    const SEL = {
        // V2
        getReserves: '0x0902f1ac',
        // V3
        slot0: '0x3850c7bd',
        liquidity: '0x1a686502',
        ticks: '0xf30dba93',
        tickBitmap: '0x5339c296',
        tickSpacing: '0xd0c93a7c',
        fee: '0xddca3f43',
        // 通用
        token0: '0x0dfe1681',
        token1: '0xd21220a7',
        // ERC20
        name: '0x06fdde03',
        symbol: '0x95d89b41',
        decimals: '0x313ce567',
        totalSupply: '0x18160ddd',
        // V4 StateView
        v4GetSlot0: '0xc815641c',
        v4GetLiquidity: '0xfa6793d5',
        v4GetTickBitmap: '0x1c7ccb4c',
        v4GetTickLiquidity: '0xcaedab54'
    };

    // BSC 上的 Uniswap V4（已在链上核对：StateView.poolManager() == POOL_MANAGER）
    const V4 = {
        poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
        stateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
        // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
        initializeTopic: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
    };

    // 动态费率标记（LPFeeLibrary.DYNAMIC_FEE_FLAG）
    const DYNAMIC_FEE_FLAG = 0x800000;

    // keccak256 实现：浏览器里用 web3，Node 测试时可从外部注入
    let _keccak = null;
    function keccak256(hex) {
        if (_keccak) return _keccak(hex);
        if (root.Keccak && root.Keccak.keccak256Hex) return root.Keccak.keccak256Hex(hex);
        throw new Error('缺少 keccak256 实现（src/keccak.js 未加载？）');
    }

    // ---------- ERC20 元数据 ----------

    async function loadTokenMeta(rpc, addresses, blockTag) {
        const calls = [];
        for (const a of addresses) {
            calls.push({ to: a, data: SEL.name });
            calls.push({ to: a, data: SEL.symbol });
            calls.push({ to: a, data: SEL.decimals });
            calls.push({ to: a, data: SEL.totalSupply });
        }
        const res = await rpc.batchCall(calls, blockTag);
        return addresses.map((a, i) => {
            const base = i * 4;
            return {
                address: a,
                name: Rpc.decodeString(res[base]) || '未知代币',
                symbol: Rpc.decodeString(res[base + 1]) || '???',
                decimals: res[base + 2] ? Number(Rpc.wordToBigInt(Rpc.words(res[base + 2])[0])) : 18,
                totalSupply: res[base + 3] ? Rpc.wordToBigInt(Rpc.words(res[base + 3])[0]).toString() : '0'
            };
        });
    }

    /** 原生币（V4 里 currency 可以是 address(0)） */
    function nativeMeta(symbol) {
        return {
            address: ZERO_ADDR,
            name: symbol || 'Native',
            symbol: symbol || 'BNB',
            decimals: 18,
            totalSupply: '0',
            isNative: true
        };
    }

    // ---------- 归一化结果 ----------

    function normalize(adapter, r, extra) {
        const up = r.direction === 'in';
        const out = Object.assign({
            ok: true,
            kind: adapter.kind,
            reached: r.reached,
            exhausted: !!r.exhausted,
            outOfRange: !!r.outOfRange,
            incomplete: !!r.incomplete,
            direction: r.direction,
            tokenIn: up ? adapter.token1Info.symbol : adapter.token0Info.symbol,
            tokenOut: up ? adapter.token0Info.symbol : adapter.token1Info.symbol,
            tokenInAddress: up ? adapter.token1Info.address : adapter.token0Info.address,
            tokenOutAddress: up ? adapter.token0Info.address : adapter.token1Info.address,
            amountIn: r.amountInGross,
            amountOut: r.amountOut,
            feePaid: r.feePaid,
            quoteFlow: r.quoteFlow,
            priceBefore: r.priceBefore,
            priceAfter: r.priceAfter,
            ticksCrossed: r.ticksCrossed || 0,
            feePips: r.feePips
        }, extra || {});
        return out;
    }

    // ======================================================================
    // V2
    // ======================================================================

    class V2Adapter {
        constructor(rpc, address, meta, reserves, feePips, blockTag) {
            this.kind = 'v2';
            this.rpc = rpc;
            this.address = address;
            this.blockTag = blockTag;
            this.token0Info = meta[0];
            this.token1Info = meta[1];
            this.reserve0 = reserves[0];   // BigInt，裸数量
            this.reserve1 = reserves[1];
            this.feePips = feePips;        // PancakeSwap V2 = 2500 (0.25%)
        }

        r0() { return Number(this.reserve0) / Math.pow(10, this.token0Info.decimals); }
        r1() { return Number(this.reserve1) / Math.pow(10, this.token1Info.decimals); }

        spotPrice() { return this.r1() / this.r0(); }

        /**
         * 恒定乘积 + 手续费的精确解。
         * 手续费留在储备里会改变曲线，所以不能直接用无费公式，要解一元二次方程：
         *     买入 token0： (1−f)a² + (2−f)·r₁·a + r₁² − k·P = 0
         *     卖出 token0： (1−f)b² + (2−f)·r₀·b + r₀² − k/P = 0
         */
        async solveToPrice(targetPrice) {
            const r0 = this.r0(), r1 = this.r1();
            const k = r0 * r1;
            const f = this.feePips / 1e6;
            const cur = r1 / r0;

            if (!(targetPrice > 0) || !isFinite(targetPrice)) {
                return { ok: false, error: '目标价格无效' };
            }

            let amountIn, amountOut, newR0, newR1, direction;

            if (Math.abs(targetPrice - cur) / cur < 1e-12) {
                return normalize(this, {
                    direction: 'in', reached: true, amountInGross: 0, amountOut: 0,
                    feePaid: 0, quoteFlow: 0, priceBefore: cur, priceAfter: cur, feePips: this.feePips
                }, { newReserve0: r0, newReserve1: r1 });
            }

            if (targetPrice > cur) {
                // 投入 token1 买 token0
                const A = 1 - f, B = (2 - f) * r1, C = r1 * r1 - k * targetPrice;
                const disc = B * B - 4 * A * C;
                if (disc < 0) return { ok: false, error: '无解' };
                amountIn = (-B + Math.sqrt(disc)) / (2 * A);
                newR1 = r1 + amountIn;
                newR0 = k / (r1 + amountIn * (1 - f));
                amountOut = r0 - newR0;
                direction = 'in';
            } else {
                // 投入 token0 卖出，换回 token1
                const A = 1 - f, B = (2 - f) * r0, C = r0 * r0 - k / targetPrice;
                const disc = B * B - 4 * A * C;
                if (disc < 0) return { ok: false, error: '无解' };
                amountIn = (-B + Math.sqrt(disc)) / (2 * A);
                newR0 = r0 + amountIn;
                newR1 = k / (r0 + amountIn * (1 - f));
                amountOut = r1 - newR1;
                direction = 'out';
            }

            const netIn = amountIn * (1 - f);
            return normalize(this, {
                direction: direction,
                reached: true,
                amountInGross: amountIn,
                amountOut: amountOut,
                feePaid: amountIn - netIn,
                quoteFlow: direction === 'in' ? amountIn : -amountOut,
                priceBefore: cur,
                priceAfter: newR1 / newR0,
                feePips: this.feePips
            }, { newReserve0: newR0, newReserve1: newR1 });
        }
    }

    // ======================================================================
    // V3
    // ======================================================================

    class V3Adapter {
        constructor(rpc, address, meta, state, blockTag) {
            this.kind = 'v3';
            this.rpc = rpc;
            this.address = address;
            this.token0Info = meta[0];
            this.token1Info = meta[1];
            this.state = state;   // { sqrtPriceX96, tick, liquidity, tickSpacing, feePips }
            this.blockTag = blockTag;
        }

        spotPrice() {
            return TickMath.sqrtRatioX96ToPrice(
                this.state.sqrtPriceX96, this.token0Info.decimals, this.token1Info.decimals);
        }

        _source() {
            const self = this;
            return {
                loadState: async () => self.state,

                loadBitmapWords: async (wordList) => {
                    const calls = wordList.map(w => ({
                        to: self.address,
                        data: SEL.tickBitmap + Rpc.encInt(w)
                    }));
                    const res = await self.rpc.batchCall(calls, self.blockTag);
                    const map = new Map();
                    wordList.forEach((w, i) => {
                        if (res[i]) map.set(w, Rpc.wordToBigInt(Rpc.words(res[i])[0]));
                    });
                    return map;
                },

                loadTickLiquidityNet: async (ticks) => {
                    const map = new Map();
                    if (!ticks.length) return map;
                    const calls = ticks.map(t => ({
                        to: self.address,
                        data: SEL.ticks + Rpc.encInt(t)
                    }));
                    const res = await self.rpc.batchCall(calls, self.blockTag);
                    ticks.forEach((t, i) => {
                        if (res[i]) {
                            const w = Rpc.words(res[i]);
                            // ticks(): word0=liquidityGross(uint128), word1=liquidityNet(int128)
                            if (w.length > 1) map.set(t, Rpc.wordToSigned(w[1], 128));
                        }
                    });
                    return map;
                }
            };
        }

        async solveToPrice(targetPrice) {
            const d0 = this.token0Info.decimals, d1 = this.token1Info.decimals;
            const target = TickMath.priceToSqrtRatioX96(targetPrice, d0, d1);
            const r = await CLSolver.solveToSqrtPrice(this._source(), target, { decimals0: d0, decimals1: d1 });
            return normalize(this, r);
        }
    }

    // ======================================================================
    // V4
    // ======================================================================

    /** poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) */
    function computePoolId(key) {
        const enc = '0x'
            + Rpc.encAddress(key.currency0)
            + Rpc.encAddress(key.currency1)
            + Rpc.encUint(key.fee)
            + Rpc.encInt(key.tickSpacing)
            + Rpc.encAddress(key.hooks);
        return keccak256(enc);
    }

    class V4Adapter {
        constructor(rpc, poolKey, poolId, meta, state, blockTag) {
            this.kind = 'v4';
            this.rpc = rpc;
            this.poolKey = poolKey;
            this.poolId = poolId;
            this.address = V4.stateView;
            this.token0Info = meta[0];
            this.token1Info = meta[1];
            this.state = state;
            this.blockTag = blockTag;
        }

        spotPrice() {
            return TickMath.sqrtRatioX96ToPrice(
                this.state.sqrtPriceX96, this.token0Info.decimals, this.token1Info.decimals);
        }

        _source(feePips) {
            const self = this;
            const idHex = self.poolId.replace(/^0x/, '');
            return {
                loadState: async () => Object.assign({}, self.state, { feePips: feePips }),

                loadBitmapWords: async (wordList) => {
                    const calls = wordList.map(w => ({
                        to: V4.stateView,
                        data: SEL.v4GetTickBitmap + idHex + Rpc.encInt(w)
                    }));
                    const res = await self.rpc.batchCall(calls, self.blockTag);
                    const map = new Map();
                    wordList.forEach((w, i) => {
                        if (res[i]) map.set(w, Rpc.wordToBigInt(Rpc.words(res[i])[0]));
                    });
                    return map;
                },

                loadTickLiquidityNet: async (ticks) => {
                    const map = new Map();
                    if (!ticks.length) return map;
                    const calls = ticks.map(t => ({
                        to: V4.stateView,
                        data: SEL.v4GetTickLiquidity + idHex + Rpc.encInt(t)
                    }));
                    const res = await self.rpc.batchCall(calls, self.blockTag);
                    ticks.forEach((t, i) => {
                        if (res[i]) {
                            const w = Rpc.words(res[i]);
                            // getTickLiquidity(): word0=liquidityGross, word1=liquidityNet(int128)
                            if (w.length > 1) map.set(t, Rpc.wordToSigned(w[1], 128));
                        }
                    });
                    return map;
                }
            };
        }

        /**
         * V4 的总 swap 费 = 协议费 + LP 费 − 两者乘积（ProtocolFeeLibrary.calculateSwapFee）。
         * 协议费按方向分两半：低 12 位是 zeroForOne（卖出 token0），高 12 位是 oneForZero。
         */
        _effectiveFeePips(up) {
            const lpFee = this.state.lpFee;
            const pf = this.state.protocolFee;
            const half = up ? ((pf >> 12) & 0xfff) : (pf & 0xfff);
            return half + lpFee - Math.floor((half * lpFee) / 1e6);
        }

        async solveToPrice(targetPrice) {
            const d0 = this.token0Info.decimals, d1 = this.token1Info.decimals;
            const target = TickMath.priceToSqrtRatioX96(targetPrice, d0, d1);
            const up = target > BigInt(this.state.sqrtPriceX96);
            const feePips = this._effectiveFeePips(up);

            const r = await CLSolver.solveToSqrtPrice(
                this._source(feePips), target, { decimals0: d0, decimals1: d1 });

            const hooked = this.poolKey.hooks && this.poolKey.hooks.toLowerCase() !== ZERO_ADDR;
            return normalize(this, r, {
                hooks: this.poolKey.hooks,
                hasHooks: !!hooked,
                dynamicFee: Number(this.poolKey.fee) === DYNAMIC_FEE_FLAG,
                note: hooked
                    ? ' 该池带 hook，hook 可在 beforeSwap 改写费率或直接返回 delta，实际所需资金可能与此结果不同'
                    : null
            });
        }
    }

    // ---------- V4 状态读取 ----------

    async function loadV4State(rpc, poolId, blockTag) {
        const id = poolId.replace(/^0x/, '');
        const res = await rpc.batchCall([
            { to: V4.stateView, data: SEL.v4GetSlot0 + id },
            { to: V4.stateView, data: SEL.v4GetLiquidity + id }
        ], blockTag);

        if (!res[0]) throw new Error('读取 V4 slot0 失败');
        const w = Rpc.words(res[0]);
        const sqrtPriceX96 = Rpc.wordToBigInt(w[0]);
        if (sqrtPriceX96 === 0n) {
            throw new Error('该 poolId 在 PoolManager 上未初始化（slot0 全零）');
        }
        return {
            sqrtPriceX96: sqrtPriceX96,
            tick: Number(Rpc.wordToSigned(w[1], 24)),
            protocolFee: Number(Rpc.wordToBigInt(w[2])),
            lpFee: Number(Rpc.wordToBigInt(w[3])),
            liquidity: res[1] ? Rpc.wordToBigInt(Rpc.words(res[1])[0]) : 0n
        };
    }

    /**
     * 只知道 poolId 时，尝试从 Initialize 事件反查 PoolKey。
     * 该 RPC 的 getLogs 单次最多 5000 个区块，所以只能扫最近若干个窗口——
     * 老池子查不到属正常情况，此时需要用户直接填 PoolKey。
     */
    async function resolvePoolKeyFromLogs(rpc, poolId, opts) {
        const o = opts || {};
        const windows = o.windows || 6;
        const span = o.span || 4900;
        const latest = Number(BigInt(await rpc.blockNumber()));
        for (let i = 0; i < windows; i++) {
            const hi = latest - i * span;
            const lo = Math.max(0, hi - span);
            let logs;
            try {
                logs = await rpc.getLogs({
                    address: V4.poolManager,
                    topics: [V4.initializeTopic, poolId],
                    fromBlock: '0x' + lo.toString(16),
                    toBlock: '0x' + hi.toString(16)
                });
            } catch (e) {
                continue;
            }
            if (logs && logs.length) {
                const l = logs[0];
                const data = l.data.replace(/^0x/, '');
                return {
                    currency0: '0x' + l.topics[2].slice(26),
                    currency1: '0x' + l.topics[3].slice(26),
                    fee: Number(BigInt('0x' + data.slice(0, 64))),
                    tickSpacing: Number(Rpc.wordToSigned(data.slice(64, 128), 24)),
                    hooks: '0x' + data.slice(128, 192).slice(24)
                };
            }
        }
        return null;
    }

    // ======================================================================
    // 入口：识别池型并构造适配器
    // ======================================================================

    const isAddress = s => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
    const isPoolId = s => /^0x[0-9a-fA-F]{64}$/.test(String(s || '').trim());

    /**
     * @param rpcUrl  RPC 地址
     * @param input   池子地址（V2/V3）或 poolId（V4）
     * @param opts    { poolKey, v2FeePips, nativeSymbol, rpc, blockTag }
     *                批量扫池子时可以传入已有的 rpc 与 blockTag，
     *                这样所有池子读的是同一个区块快照，横向加总才有意义
     */
    async function createAdapter(rpcUrl, input, opts) {
        const o = opts || {};
        const rpc = o.rpc || new Rpc.RpcClient(rpcUrl);
        const blockTag = o.blockTag || await rpc.blockNumber();   // 固定区块，保证所有读取是同一个快照
        const target = String(input || '').trim();

        // ---- V4：poolId 或显式 PoolKey ----
        if (isPoolId(target) || o.poolKey) {
            let poolKey = o.poolKey || null;
            let poolId = isPoolId(target) ? target.toLowerCase() : null;

            if (poolKey) {
                const computed = computePoolId(poolKey).toLowerCase();
                if (poolId && computed !== poolId) {
                    throw new Error('填写的 PoolKey 算出的 poolId 与输入不一致：' + computed);
                }
                poolId = computed;
            } else {
                poolKey = await resolvePoolKeyFromLogs(rpc, poolId);
                if (!poolKey) {
                    throw new Error(
                        '无法从最近区块的 Initialize 事件反查到这个 poolId 的 PoolKey。' +
                        '该 RPC 的 getLogs 单次上限 5000 个区块，老池子查不到属正常——请改用「V4 PoolKey」面板直接填入五元组。');
                }
            }

            const state = await loadV4State(rpc, poolId, blockTag);

            const c0 = poolKey.currency0.toLowerCase();
            const c1 = poolKey.currency1.toLowerCase();
            const erc = [c0, c1].filter(a => a !== ZERO_ADDR);
            const fetched = erc.length ? await loadTokenMeta(rpc, erc, blockTag) : [];
            const pick = a => a === ZERO_ADDR
                ? nativeMeta(o.nativeSymbol || 'BNB')
                : fetched[erc.indexOf(a)];
            const meta = [pick(c0), pick(c1)];

            return new V4Adapter(rpc, poolKey, poolId, meta, state, blockTag);
        }

        if (!isAddress(target)) {
            throw new Error('请输入有效的池子地址（40 位 hex）或 V4 poolId（64 位 hex）');
        }

        // ---- V2 / V3：先试 getReserves，revert 再试 slot0 ----
        const probe = await rpc.batchCall([
            { to: target, data: SEL.getReserves },
            { to: target, data: SEL.slot0 },
            { to: target, data: SEL.token0 },
            { to: target, data: SEL.token1 }
        ], blockTag);

        if (!probe[2] || !probe[3]) {
            throw new Error('该地址不是可识别的池子合约（token0/token1 读取失败）');
        }
        const t0 = Rpc.wordToAddress(Rpc.words(probe[2])[0]);
        const t1 = Rpc.wordToAddress(Rpc.words(probe[3])[0]);
        const meta = await loadTokenMeta(rpc, [t0, t1], blockTag);

        if (probe[0]) {
            const w = Rpc.words(probe[0]);
            return new V2Adapter(rpc, target, meta,
                [Rpc.wordToBigInt(w[0]), Rpc.wordToBigInt(w[1])],
                o.v2FeePips === undefined ? 2500 : o.v2FeePips, blockTag);
        }

        if (probe[1]) {
            const w = Rpc.words(probe[1]);
            const extra = await rpc.batchCall([
                { to: target, data: SEL.liquidity },
                { to: target, data: SEL.tickSpacing },
                { to: target, data: SEL.fee }
            ], blockTag);
            if (!extra[0] || !extra[1] || !extra[2]) {
                throw new Error('V3 池状态读取不全（liquidity / tickSpacing / fee）');
            }
            const state = {
                sqrtPriceX96: Rpc.wordToBigInt(w[0]),
                tick: Number(Rpc.wordToSigned(w[1], 24)),
                liquidity: Rpc.wordToBigInt(Rpc.words(extra[0])[0]),
                tickSpacing: Number(Rpc.wordToSigned(Rpc.words(extra[1])[0], 24)),
                feePips: Number(Rpc.wordToBigInt(Rpc.words(extra[2])[0]))
            };
            return new V3Adapter(rpc, target, meta, state, blockTag);
        }

        throw new Error('无法识别池子类型：getReserves() 和 slot0() 都调用失败');
    }

    root.PoolAdapters = {
        createAdapter,
        computePoolId,
        resolvePoolKeyFromLogs,
        loadTokenMeta,
        V2Adapter, V3Adapter, V4Adapter,
        V4, SEL, ZERO_ADDR, DYNAMIC_FEE_FLAG,
        setKeccak: fn => { _keccak = fn; },
        isAddress, isPoolId
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
