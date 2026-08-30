/**
 * 极简 JSON-RPC 批量 eth_call 层
 *
 * 为什么不用 Multicall3：一次求解要读几十上百个 tick 位图和 tick，关键需求是
 * (1) 少往返、(2) 所有读取落在同一个区块。把区块号固定住之后，JSON-RPC 批量请求
 * 就已经同时满足这两点，而且不依赖任何链上合约、不用给嵌套结构体做 ABI 编码。
 * 批量不被 RPC 支持时自动退化成顺序调用。
 */
(function (root) {
    'use strict';

    // 单个 HTTP 请求里最多打包多少个 eth_call。
    // 实测 rpc-bsc.48.club 上 700 条一批会直接 429，50 条稳定。
    const MAX_BATCH = 50;
    const CHUNK_PAUSE_MS = 60;   // 分片之间稍微喘口气，避免触发限流
    const MAX_RETRY = 3;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---------- ABI 编解码（只处理定长 32 字节参数，够用了） ----------

    function padHex(hex) {
        const h = hex.replace(/^0x/, '');
        return h.padStart(64, '0');
    }

    /** 无符号整数 -> 32 字节 hex */
    function encUint(v) {
        return padHex(BigInt(v).toString(16));
    }

    /** 有符号整数 -> 32 字节 hex（二补码符号扩展，用于 int24 / int16） */
    function encInt(v) {
        let b = BigInt(v);
        if (b < 0n) b += 1n << 256n;
        return padHex(b.toString(16));
    }

    function encAddress(a) {
        return padHex(String(a).replace(/^0x/, '').toLowerCase());
    }

    function encBytes32(b) {
        return padHex(String(b).replace(/^0x/, '').toLowerCase());
    }

    /** 把返回数据切成 32 字节的字 */
    function words(hex) {
        const h = String(hex || '').replace(/^0x/, '');
        const out = [];
        for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
        return out;
    }

    function wordToBigInt(w) {
        return BigInt('0x' + w);
    }

    /** 按位宽还原有符号整数 */
    function wordToSigned(w, bits) {
        let v = BigInt('0x' + w);
        const half = 1n << BigInt(bits - 1);
        const full = 1n << BigInt(bits);
        // 高位补满 1 的负数，先截到目标位宽再判符号
        v = v & (full - 1n);
        return v >= half ? v - full : v;
    }

    function wordToAddress(w) {
        return '0x' + w.slice(24);
    }

    /** 解析 ABI 编码的 string 返回值（用于 name()/symbol()） */
    function decodeString(hex) {
        const h = String(hex || '').replace(/^0x/, '');
        if (h.length < 128) return '';
        try {
            const len = Number(BigInt('0x' + h.slice(64, 128)));
            const body = h.slice(128, 128 + len * 2);
            let s = '';
            for (let i = 0; i < body.length; i += 2) {
                s += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
            }
            return decodeURIComponent(escape(s));
        } catch (e) {
            return '';
        }
    }

    // ---------- 客户端 ----------

    class RpcClient {
        constructor(url) {
            this.url = url;
            this.id = 1;
        }

        async _post(payload) {
            let lastErr;
            for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
                try {
                    const res = await fetch(this.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    if (res.status === 429 || res.status === 503) {
                        // 被限流：退避后重试
                        lastErr = new Error('RPC HTTP ' + res.status);
                        await sleep(300 * (attempt + 1) * (attempt + 1));
                        continue;
                    }
                    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
                    return res.json();
                } catch (e) {
                    lastErr = e;
                    if (attempt === MAX_RETRY - 1) break;
                    await sleep(300 * (attempt + 1));
                }
            }
            throw lastErr || new Error('RPC 请求失败');
        }

        async blockNumber() {
            const r = await this._post({ jsonrpc: '2.0', id: this.id++, method: 'eth_blockNumber', params: [] });
            if (r.error) throw new Error('eth_blockNumber: ' + r.error.message);
            return r.result;
        }

        /** 单个 eth_call；revert 时返回 null（由调用方决定是否算失败） */
        async call(to, data, blockTag) {
            const r = await this._post({
                jsonrpc: '2.0', id: this.id++, method: 'eth_call',
                params: [{ to, data }, blockTag || 'latest']
            });
            if (r.error) return null;
            return r.result;
        }

        /**
         * 批量 eth_call。calls: [{ to, data }]
         * 返回与入参等长的数组，元素为返回数据 hex，revert 的位置是 null。
         */
        async batchCall(calls, blockTag) {
            const tag = blockTag || 'latest';
            const out = new Array(calls.length).fill(null);

            for (let start = 0; start < calls.length; start += MAX_BATCH) {
                if (start > 0) await sleep(CHUNK_PAUSE_MS);
                const slice = calls.slice(start, start + MAX_BATCH);
                const payload = slice.map((c, i) => ({
                    jsonrpc: '2.0',
                    id: start + i,
                    method: 'eth_call',
                    params: [{ to: c.to, data: c.data }, tag]
                }));

                let handled = false;
                try {
                    const res = await this._post(payload);
                    if (Array.isArray(res)) {
                        for (const item of res) {
                            const idx = Number(item.id);
                            if (idx >= 0 && idx < out.length && !item.error) out[idx] = item.result;
                        }
                        handled = true;
                    }
                } catch (e) {
                    // 落到下面的顺序回退
                }

                if (!handled) {
                    // RPC 不支持批量：退化成逐个调用
                    for (let i = 0; i < slice.length; i++) {
                        out[start + i] = await this.call(slice[i].to, slice[i].data, tag);
                    }
                }
            }
            return out;
        }

        async getLogs(params) {
            const r = await this._post({ jsonrpc: '2.0', id: this.id++, method: 'eth_getLogs', params: [params] });
            if (r.error) throw new Error('eth_getLogs: ' + r.error.message);
            return r.result;
        }
    }

    root.Rpc = {
        RpcClient,
        encUint, encInt, encAddress, encBytes32,
        words, wordToBigInt, wordToSigned, wordToAddress, decodeString,
        MAX_BATCH
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
