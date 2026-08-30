/**
 * 最小 Keccak-256 实现（浏览器 / Node 通用）
 *
 * 计算 V4 的 poolId = keccak256(abi.encode(PoolKey)) 要用。
 * 独立实现是为了让页面不依赖 web3 —— 少一个 CDN 就少一个加载失败的可能。
 */
(function (root) {
    'use strict';

const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
    0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
    0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14]
];

const MASK = (1n << 64n) - 1n;
const rol = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccak256(bytes) {
    const rate = 136;
    const input = Array.from(bytes);
    input.push(0x01);
    while (input.length % rate !== 0) input.push(0);
    input[input.length - 1] ^= 0x80;

    const S = [];
    for (let x = 0; x < 5; x++) S.push([0n, 0n, 0n, 0n, 0n]);

    for (let off = 0; off < input.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(input[off + i * 8 + b]);
            S[i % 5][Math.floor(i / 5)] ^= lane;
        }

        for (let rnd = 0; rnd < 24; rnd++) {
            const C = [];
            for (let x = 0; x < 5; x++) C.push(S[x][0] ^ S[x][1] ^ S[x][2] ^ S[x][3] ^ S[x][4]);
            const D = [];
            for (let x = 0; x < 5; x++) D.push(C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1));
            for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) S[x][y] ^= D[x];

            const B = [];
            for (let x = 0; x < 5; x++) B.push([0n, 0n, 0n, 0n, 0n]);
            for (let x = 0; x < 5; x++)
                for (let y = 0; y < 5; y++)
                    B[y][(2 * x + 3 * y) % 5] = rol(S[x][y], ROT[x][y]);

            for (let x = 0; x < 5; x++)
                for (let y = 0; y < 5; y++)
                    S[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & MASK) & B[(x + 2) % 5][y]);

            S[0][0] ^= RC[rnd];
        }
    }

    const out = [];
    for (let i = 0; i < 4; i++) {
        let lane = S[i % 5][Math.floor(i / 5)];
        for (let b = 0; b < 8; b++) { out.push(Number(lane & 0xffn)); lane >>= 8n; }
    }
    return out;
}

/** 入参出参都是 0x 前缀的 hex 字符串 */
function keccak256Hex(hex) {
    const h = String(hex).replace(/^0x/, '');
    const bytes = [];
    for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    return '0x' + keccak256(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

    root.Keccak = { keccak256, keccak256Hex };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { keccak256, keccak256Hex };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
