// accounting-redis.js
// Iekšējā grāmatvedība ar Upstash Redis – lietotāju kredītu un iemaksu uzskaite.
// Internal accounting with Upstash Redis – user credits and deposits tracking.

import { Redis } from '@upstash/redis';

let redis = null;

/**
 * Inicializē Redis, ja vides mainīgie ir pieejami.
 * Initializes Redis if environment variables are available.
 */
export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        console.log('✅ Redis inicializēts | Redis initialized');
    } else {
        console.log('⚠️ Redis nav konfigurēts | Redis is not configured');
    }
    return redis;
}

/**
 * Iegūst lietotāja kredītu bilanci.
 * Gets user credits balance.
 */
export async function getUserCredits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const credits = await redis.get(`user:${walletAddress.toLowerCase()}:winc`);
        return BigInt(String(credits || '0'));
    } catch (e) {
        console.warn('Redis get kļūda | Redis get error:', e.message);
        return 0n;
    }
}

/**
 * Atoma debeta operācija — atņem kredītus tikai, ja pietiek.
 * Atomic debit operation — deducts credits only if sufficient.
 * @returns {Promise<{success: boolean, balance: bigint, error: string|null}>}
 */
export async function debitUserCredits(walletAddress, amount) {
    if (!redis) {
        return { success: false, balance: 0n, error: 'Redis nav konfigurēts' };
    }
    
    const key = `user:${walletAddress.toLowerCase()}:winc`;
    
    try {
        const luaScript = `
            local current = redis.call('GET', KEYS[1])
            local currentVal = tonumber(current or '0')
            local debitVal = tonumber(ARGV[1])
            
            if currentVal < debitVal then
                return {currentVal, 0}
            end
            
            local newVal = currentVal - debitVal
            redis.call('SET', KEYS[1], tostring(newVal))
            return {newVal, 1}
        `;
        
        const result = await redis.eval(luaScript, [key], [amount.toString()]);
        
        if (result && result[1] === 1) {
            const newBalance = BigInt(result[0]);
            return { success: true, balance: newBalance, error: null };
        } else {
            const currentBalance = BigInt(result ? result[0] : 0);
            return { success: false, balance: currentBalance, error: 'Nepietiek līdzekļu' };
        }
    } catch (e) {
        console.error('Redis debit kļūda | Redis debit error:', e.message);
        return { success: false, balance: 0n, error: e.message };
    }
}

/**
 * Atoma kredīta operācija — pievieno kredītus.
 * Atomic credit operation — adds credits.
 * @returns {Promise<{success: boolean, balance: bigint, error: string|null}>}
 */
export async function creditUserCredits(walletAddress, amount) {
    if (!redis) {
        return { success: false, balance: 0n, error: 'Redis nav konfigurēts' };
    }
    
    const key = `user:${walletAddress.toLowerCase()}:winc`;
    
    try {
        const luaScript = `
            local current = redis.call('GET', KEYS[1])
            local currentVal = tonumber(current or '0')
            local creditVal = tonumber(ARGV[1])
            local newVal = currentVal + creditVal
            redis.call('SET', KEYS[1], tostring(newVal))
            return newVal
        `;
        
        const result = await redis.eval(luaScript, [key], [amount.toString()]);
        const newBalance = BigInt(result);
        
        return { success: true, balance: newBalance, error: null };
    } catch (e) {
        console.error('Redis credit kļūda | Redis credit error:', e.message);
        return { success: false, balance: 0n, error: e.message };
    }
}

/**
 * Saglabā job stāvokli idempotencei.
 * Stores job state for idempotency.
 */
export async function setJobState(jobId, state) {
    if (!redis) return;
    
    try {
        await redis.set(`job:${jobId}`, JSON.stringify(state));
    } catch (e) {
        console.warn('Redis job set kļūda | Redis job set error:', e.message);
    }
}

/**
 * Iegūst job stāvokli.
 * Gets job state.
 */
export async function getJobState(jobId) {
    if (!redis) return null;
    
    try {
        const state = await redis.get(`job:${jobId}`);
        return state ? JSON.parse(state) : null;
    } catch (e) {
        console.warn('Redis job get kļūda | Redis job get error:', e.message);
        return null;
    }
}

/**
 * Atjaunina lietotāja kredītu bilanci (tieša iestatīšana).
 * Updates user credits balance (direct set).
 */
export async function setUserCredits(walletAddress, wincAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:winc`, wincAmount.toString());
    } catch (e) {
        console.warn('Redis set kļūda | Redis set error:', e.message);
    }
}

/**
 * Atgriež Redis klientu.
 * Returns the Redis client.
 */
export function getRedis() {
    return redis;
}
