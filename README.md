# AMM Pool 价格计算器

一个零构建的单页工具：给定一个 AMM 池子，回答**「把这个币从 X 市值推到 Y 市值，需要多少资金净流入 / 流出？」**

支持三种池型：

| 池型 | 输入 | 求解方式 |
|---|---|---|
| **V2**（PancakeSwap / Uniswap V2 及其分叉） | 池子地址 | 恒定乘积 + 手续费的精确解 |
| **V3**（集中流动性） | 池子地址 | 跨 tick 逐段积分 |
| **V4**（Uniswap V4，单例 PoolManager） | poolId 或 PoolKey 五元组 | 同上，共用一个引擎 |

## 用法

用任意静态服务器把仓库根目录挂起来，打开 `index.html` 即可（直接双击用 `file://` 打开也能跑）：

```bash
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

- **V2 / V3**：把池子地址粘进「Pool 地址」，点「加载池子信息」。池型是自动识别的（先试 `getReserves()`，revert 就按 V3 读 `slot0()`）。
- **V4**：勾选「使用 V4 PoolKey 指定池子」，填 currency0 / currency1 / fee / tickSpacing / hooks，poolId 会自动算出来。
  只有 poolId 没有 PoolKey 时也可以直接粘 poolId，程序会去最近的区块里翻 `Initialize` 事件反查——
  但公共 RPC 的 `getLogs` 单次上限通常是 5000 个区块，老池子多半翻不到，还是填 PoolKey 最稳。

填好目标市值（或目标价格）后，「需要」那一栏就会给出所需的资金净流入 / 流出。

单池的答案是**偏低的**——把一个池推到目标价，套利会立刻从别的池把价格拉回来。
点「🌐 汇总全部池子」会枚举该 token 在各家工厂上的所有 V2/V3/V4 池，
把它们都推到同一个目标美元价，再把各池所需资金折成美元加总。实测 CAKE +10%：
单个最深的池只要 41 万美元，全部场地加起来要 156 万，差 3.8 倍。

## 代码结构

```
index.html          页面与交互
src/keccak.js       Keccak-256（算 V4 的 poolId 用）
src/tickmath.js     tick ⇄ sqrtPriceX96 互转（全 BigInt）
src/rpc.js          批量 eth_call（固定区块号，保证同一快照）
src/pricing.js      报价币的美元定价
src/clsolver.js     集中流动性求解器 —— V3 / V4 共用
src/adapters.js     V2 / V3 / V4 三个适配器，统一成同一个接口
src/aggregate.js    多池聚合：枚举工厂、逐池求解、折美元加总
test/verify.js      对着链上 Quoter 验证求解结果
test/browser.js     真的把页面跑起来的端到端测试
```

页面不依赖任何 CDN——原来引的 web3.js 已经去掉了，取数、定价、keccak 全部由上面这几个模块自己完成。
少一个外部依赖就少一个加载失败的可能。

核心设计是：**V3 和 V4 的 swap 数学完全一样，差别只在状态从哪读**。所以求解器只依赖五个原语，
两个版本各自实现取数即可：

| 原语 | V3（池子合约） | V4（StateView） |
|---|---|---|
| 当前 √价格、tick | `slot0()` | `getSlot0(poolId)` |
| 活跃流动性 L | `liquidity()` | `getLiquidity(poolId)` |
| 已初始化 tick 位图 | `tickBitmap(int16)` | `getTickBitmap(poolId, int16)` |
| 跨 tick 的 liquidityNet | `ticks(int24)` | `getTickLiquidity(poolId, int24)` |
| tickSpacing / fee | `tickSpacing()` / `fee()` | 来自 PoolKey 与 `slot0.lpFee` |

V4 不需要自己算 `extsload` 存储槽，官方 StateView 已经把这些都以 view 函数暴露了。

## 多池聚合

`src/aggregate.js` 的流程：

1. 枚举工厂找候选池——PancakeSwap V2/V3、Uniswap V2/V3、Biswap V2 各自的
   `getPair` / `getPool`，配对 WBNB / USDT / BUSD / USDC / DAI / BTCB / ETH / CAKE；
   V4 没有工厂可枚举，只能扫 `Initialize` 事件
2. 先廉价读一遍深度，把灰尘池筛掉，剩下的按深度排序，最多解前 14 个
3. 各池报价币不同，所以目标价要按各自报价币的美元价换算成该池自己的口径
4. 各池所需资金折成美元后相加

所有求解共用同一个区块快照——横向加总的前提是各池状态来自同一时刻。

注意快照的**取用时点**：区块号是在「发现池子」之后才取的，不是一开始就取。
因为 V4 要扫 `Initialize` 事件，这一步可能耗时几十秒；如果一开始就把区块钉死，
等真正开始求解时那个区块对公共 RPC 来说已经偏旧，活跃池子上会读到前后不一致的状态，
表现为莫名其妙的偏差（实测在一个高频交易的 V4 池上能造成 0.1%~0.45% 的误差）。
工厂映射基本不变，所以发现阶段用 `latest` 就够了。

## 数学

**市值 → 价格**：FDV = 总供应量 × P × Q（P 是池内价格，Q 是报价币美元价）。
求解期间总供应量和 Q 是常数，所以 `P_target = P_now × (Y / X)`。

**V3 / V4**：相邻两个已初始化 tick 之间 L 恒定，此时

```
Δy = L · (√P_b − √P_a)                 token1 数量
Δx = L · (√P_b − √P_a) / (√P_a · √P_b)  token0 数量
```

逐段累加，跨 tick 时 `L ± liquidityNet`。手续费计入 `feeGrowthGlobal`、不进 swap 曲线，
所以 `amountIn = ΣΔy / (1 − f)` 是精确解。V4 的总费率还要把协议费算进去：
`protocolFee + lpFee − protocolFee·lpFee/1e6`，且协议费按方向分两半（低 12 位 zeroForOne，高 12 位 oneForZero）。

**V2**：手续费留在储备里、会改变曲线，不能套无费公式。令交易后现价等于目标价，解

```
买入 token0：(1−f)·a² + (2−f)·r₁·a + r₁² − k·P_target = 0
卖出 token0：(1−f)·b² + (2−f)·r₀·b + r₀² − k/P_target = 0
```

取正根即为含费所需投入量。

## 测试

```bash
node test/verify.js     # 数学验证，需要联网
node test/browser.js    # 端到端，需要 playwright + chromium
```

`verify.js` 的验证方式是：把求解器算出的 `amountIn` 原样喂给链上官方 Quoter
（V3 用 PancakeSwap QuoterV2，V4 用 Uniswap V4Quoter）做一次真实 swap 模拟，
再比对落点价格与产出量。实测多个池子（不同 tickSpacing 与费率）相对误差都在 `1e-14` 量级。

`browser.js` 会起一个本地静态服务器把页面真的跑起来，依次加载 V2 / V3 / V4 三种池子、
点「+10%」触发求解、检查结果渲染，并捕获所有页面异常。

## 已知边界

- **带 hook 的 V4 池**：hook 可以在 `beforeSwap` 里改写费率甚至直接返回 delta，
  此时 tick 行走只是「假设 hook 不干预」的下界。程序会在结果旁边标注。
- **深度不足**：走完目标价方向上所有已初始化 tick 仍到不了目标价，会明确报出来，
  而不是给一个看起来很小的数字。
- **聚合仍是下界**：只覆盖已配置工厂上的池子，CEX 和未收录的 DEX 不在内。
  V4 靠扫最近区块的 `Initialize` 事件发现，受 RPC 的 `getLogs` 区块上限限制，可能漏掉老池子。
  另外为了控制请求量，只解深度最大的前 14 个池（`Aggregate.DEFAULTS.maxPools` 可调）。
- **FDV 口径**：市值用 `totalSupply` 算，是全稀释估值。有大量锁仓 / 黑洞地址时会明显高于流通市值。
- **快照**：结果是当前区块的静态解，真实执行中 LP 会调仓、会被抢跑，实际成本通常更高。
- **RPC 一致性**：公共 RPC 未必长期保留历史状态。对高频交易的池子，如果读取与求解之间
  隔了太久，可能拿到前后不一致的状态。代码里已经把区块快照的取用时点尽量贴近求解，
  但换 RPC 时仍值得留意。
- **PancakeSwap Infinity**：其 CL 池需要单独的适配器（`getSlot0` 直接开在 PoolManager 上，没有 StateView 中间层）；
  Bin 池是离散 bin 模型，数学不通用。两者当前都未支持。
