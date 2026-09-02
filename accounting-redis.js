// accounting-redis.js
//
// Iekšējā grāmatvedība ar Upstash Redis.
//
// Redis tiek izmantots:
// 1. lietotāju Winc kredītu bilancēm;
// 2. Treasury payment tx claim aizsardzībai;
// 3. backup job stāvoklim;
// 4. atomiskai kredītu rezervēšanai/atgriešanai;
// 5. izkliedētajai job slēdzenei (distributed lock).

import { Redis } from '@upstash/redis';
import crypto from 'crypto';

let redis = null;

const DEFAULT_JOB_TTL = Number(process.env.JOB_TTL_SECONDS || 3600);
const JOB_LOCK_TTL = Number(process.env.JOB_LOCK_TTL_SECONDS || 30);

function normalizeWallet(walletAddress) {
    if (typeof walletAddress !== 'string') throw new Error('Wallet address nav string.');
    const normalized = walletAddress.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('Nederīga wallet address.');
    return normalized;
}

function creditsKey(walletAddress) {
    return `user:${normalizeWallet(walletAddress)}:winc`;
}

function depositsKey(walletAddress) {
    return `user:${normalizeWallet(walletAddress)}:deposits`;
}

function jobKey(jobId) {
    return `permrepo:job:${jobId}`;
}

function paymentKey(txHash) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('Nederīgs payment tx hash.');
    return `permrepo:payment:${txHash.toLowerCase()}`;
}

function jobLockKey(jobId) {
    return `permrepo:joblock:${jobId}`;
}

export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN
        });
        console.log('✅ Redis inicializēts | Redis initialized');
    } else if (!redis) {
        console.log('⚠️ Redis nav konfigurēts | Redis is not configured');
    }
    return redis;
}

export function getRedis() {
    return redis;
}

function requireRedis() {
    if (!redis) throw new Error('Redis nav konfigurēts. PermRepo grāmatvedības operācija nav pieejama.');
    return redis;
}

function parseBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    try {
        const parsed = BigInt(String(value));
        if (parsed < 0n) throw new Error('Negatīva Redis bilance.');
        return parsed;
    } catch {
        throw new Error('Redis bilance satur nederīgu skaitli.');
    }
}

export async function getUserCredits(walletAddress) {
    const client = requireRedis();
    const key = creditsKey(walletAddress);
    try {
        const value = await client.get(key);
        return parseBigInt(value);
    } catch (error) {
        console.warn('Redis get kļūda | Redis get error:', error.message);
        throw new Error('Redis kredītu nolasīšana neizdevās.');
    }
}

export async function setUserCredits(walletAddress, wincAmount) {
    const client = requireRedis();
    const amount = parseBigInt(wincAmount);
    try {
        await client.set(creditsKey(walletAddress), amount.toString());
        console.log('✅ Lietotāja kredīti atjaunināti | User credits updated:', amount.toString());
    } catch (error) {
        console.warn('Redis set kļūda | Redis set error:', error.message);
        throw new Error('Redis kredītu atjaunināšana neizdevās.');
    }
}

export async function reserveUserCredits(walletAddress, wincAmount) {
    const client = requireRedis();
    const amount = parseBigInt(wincAmount);
    if (amount <= 0n) return true;
    const key = creditsKey(walletAddress);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if not current then current = "0" end
        local balance = tonumber(current)
        local required = tonumber(ARGV[1])
        if balance >= required then
            redis.call("SET", KEYS[1], tostring(balance - required))
            return 1
        end
        return 0
    `;
    try {
        const result = await client.eval(script, [key], [amount.toString()]);
        return Number(result) === 1;
    } catch (error) {
        console.warn('Redis reserve kļūda | Redis reserve error:', error.message);
        throw new Error('Redis kredītu rezervēšana neizdevās.');
    }
}

export async function refundUserCredits(walletAddress, wincAmount) {
    const client = requireRedis();
    const amount = parseBigInt(wincAmount);
    if (amount <= 0n) return;
    const key = creditsKey(walletAddress);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if not current then current = "0" end
        local balance = tonumber(current)
        local refund = tonumber(ARGV[1])
        redis.call("SET", KEYS[1], tostring(balance + refund))
        return 1
    `;
    try {
        await client.eval(script, [key], [amount.toString()]);
        console.log('↩️ Redis kredīti atgriezti | Credits refunded:', amount.toString());
    } catch (error) {
        console.error('KRITISKA Redis refund kļūda:', error);
        throw new Error('Redis kredītu atgriešana neizdevās.');
    }
}

export async function getUserDeposits(walletAddress) {
    const client = requireRedis();
    try {
        const value = await client.get(depositsKey(walletAddress));
        return parseBigInt(value);
    } catch (error) {
        console.warn('Redis deposit get kļūda:', error.message);
        throw new Error('Redis deposit nolasīšana neizdevās.');
    }
}

export async function setUserDeposits(walletAddress, depositAmount) {
    const client = requireRedis();
    const amount = parseBigInt(depositAmount);
    try {
        await client.set(depositsKey(walletAddress), amount.toString());
        console.log('✅ Lietotāja iemaksas atjauninātas | User deposits updated:', amount.toString());
    } catch (error) {
        console.warn('Redis deposit set kļūda:', error.message);
        throw new Error('Redis deposit atjaunināšana neizdevās.');
    }
}

export async function createJob(jobId, job, ttlSeconds = DEFAULT_JOB_TTL) {
    const client = requireRedis();
    if (typeof jobId !== 'string' || jobId.length < 20) throw new Error('Nederīgs jobId.');
    if (!job || typeof job !== 'object') throw new Error('Nederīgi job dati.');
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('Nederīgs job TTL.');
    const key = jobKey(jobId);
    const value = JSON.stringify(job);
    try {
        const result = await client.set(key, value, { nx: true, ex: ttl });
        if (result !== 'OK') throw new Error('Job ar šādu ID jau eksistē.');
        return true;
    } catch (error) {
        console.error('Redis createJob kļūda:', error);
        throw new Error('Backup job izveide neizdevās.');
    }
}

export async function getJob(jobId) {
    const client = requireRedis();
    if (typeof jobId !== 'string' || jobId.length < 20) throw new Error('Nederīgs jobId.');
    try {
        const value = await client.get(jobKey(jobId));
        if (!value) return null;
        if (typeof value === 'object') return value;
        return JSON.parse(String(value));
    } catch (error) {
        console.error('Redis getJob kļūda:', error);
        throw new Error('Backup job nolasīšana neizdevās.');
    }
}

export async function updateJob(jobId, patch, ttlSeconds = DEFAULT_JOB_TTL) {
    const client = requireRedis();
    const current = await getJob(jobId);
    if (!current) throw new Error('Backup job nav atrasts.');
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await client.set(jobKey(jobId), JSON.stringify(next), { ex: Number(ttlSeconds) });
    return next;
}

export async function claimPaymentTx(txHash, metadata = {}) {
    const client = requireRedis();
    const key = paymentKey(txHash);
    const value = JSON.stringify({ txHash, ...metadata, claimedAt: Date.now() });
    try {
        const result = await client.set(key, value, { nx: true });
        return result === 'OK';
    } catch (error) {
        console.error('Redis payment claim kļūda:', error);
        throw new Error('Payment tx reģistrācija neizdevās.');
    }
}

export async function getPaymentClaim(txHash) {
    const client = requireRedis();
    try {
        const value = await client.get(paymentKey(txHash));
        if (!value) return null;
        if (typeof value === 'object') return value;
        return JSON.parse(String(value));
    } catch (error) {
        console.error('Redis payment get kļūda:', error);
        throw new Error('Payment claim nolasīšana neizdevās.');
    }
}

// ==================================================
// IZKLIEDĒTĀ JOB SLĒDZENE (DISTRIBUTED LOCK)
// ==================================================

export async function acquireJobLock(jobId, ttlSeconds = JOB_LOCK_TTL) {
    const client = requireRedis();
    const key = jobLockKey(jobId);
    const token = crypto.randomUUID();
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('Nederīgs job lock TTL.');
    try {
        const result = await client.set(key, token, { nx: true, ex: ttl });
        if (result === 'OK') return token;
        return null;
    } catch (error) {
        console.error('Redis job lock iegūšanas kļūda:', error);
        throw new Error('Redis job slēdzeni nevar iegūt.');
    }
}

export async function releaseJobLock(jobId, token) {
    const client = requireRedis();
    const key = jobLockKey(jobId);
    const script = `
        local current = redis.call("GET", KEYS[1])
        if current == ARGV[1] then
            redis.call("DEL", KEYS[1])
            return 1
        end
        return 0
    `;
    try {
        await client.eval(script, [key], [token]);
    } catch (error) {
        console.error('Redis job lock atbrīvošanas kļūda:', error);
    }
}
