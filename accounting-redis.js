// accounting-redis.js
import { Redis } from '@upstash/redis';
let redis = null;

export function initRedis() {
 if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
 redis = new Redis({
 url: process.env.UPSTASH_REDIS_REST_URL,
 token: process.env.UPSTASH_REDIS_REST_TOKEN,
 });
 console.log('Redis inicializēts');
 } else {
 console.log('Redis nav konfigurēts');
 }
 return redis;
}

export async function getUserCredits(walletAddress) {
 if (!redis) return 0n;
 try {
 const credits = await redis.get(`user:${walletAddress.toLowerCase()}:winc`);
 return BigInt(String(credits || '0'));
 } catch (e) {
 return 0n;
 }
}

export async function debitUserCredits(walletAddress, amount) {
 if (!redis) return { success: false, balance: 0n, error: 'Redis nav konfigurēts' };
 const key = `user:${walletAddress.toLowerCase()}:winc`;
 try {
 const luaScript = `
 local current = redis.call('GET', KEYS[1])
 local currentVal = tonumber(current or '0')
 local debitVal = tonumber(ARGV[1])
 if currentVal < debitVal then return {currentVal, 0} end
 local newVal = currentVal - debitVal
 redis.call('SET', KEYS[1], tostring(newVal))
 return {newVal, 1}
 `;
 const result = await redis.eval(luaScript, [key], [amount.toString()]);
 if (result && result[1] === 1) {
 return { success: true, balance: BigInt(result[0]), error: null };
 } else {
 return { success: false, balance: BigInt(result ? result[0] : 0), error: 'Nepietiek līdzekļu' };
 }
 } catch (e) {
 return { success: false, balance: 0n, error: e.message };
 }
}

/**
 * Idempotenta kredīta piešķiršana/kompensācija, kas novērš dubultu izmaksu.
 */
export async function creditUserCredits(walletAddress, amount, jobId = 'general', paymentTxHash = 'none') {
 if (!redis) return { success: false, balance: 0n, error: 'Redis nav konfigurēts' };
 
 const balanceKey = `user:${walletAddress.toLowerCase()}:winc`;
 const txKey = `processed_credit:${jobId}:${paymentTxHash}`;
 
 try {
 const luaScript = `
 local alreadyProcessed = redis.call('EXISTS', KEYS[2])
 if alreadyProcessed == 1 then
 local current = redis.call('GET', KEYS[1])
 return {tonumber(current or '0'), 0}
 end
 
 redis.call('SET', KEYS[2], '1', 'EX', 2592000)
 local current = redis.call('GET', KEYS[1])
 local currentVal = tonumber(current or '0')
 local creditVal = tonumber(ARGV[1])
 local newVal = currentVal + creditVal
 redis.call('SET', KEYS[1], tostring(newVal))
 return {newVal, 1}
 `;
 
 const result = await redis.eval(luaScript, [balanceKey, txKey], [amount.toString()]);
 if (result && result[1] === 1) {
 return { success: true, balance: BigInt(result[0]), processed: true };
 } else {
 return { success: true, balance: BigInt(result[0]), processed: false, message: 'Jau kreditēts iepriekš' };
 }
 } catch (e) {
 return { success: false, balance: 0n, error: e.message };
 }
}

export async function setJobState(jobId, state) {
 if (!redis) return;
 try {
 await redis.set(`job:${jobId}`, JSON.stringify(state));
 } catch (e) {}
}

export async function getJobState(jobId) {
 if (!redis) return null;
 try {
 const state = await redis.get(`job:${jobId}`);
 if (!state) return null;
 return typeof state === 'string' ? JSON.parse(state) : state;
 } catch (e) {
 return null;
 }
}

export async function setUserCredits(walletAddress, wincAmount) {
 if (!redis) return;
 try {
 await redis.set(`user:${walletAddress.toLowerCase()}:winc`, wincAmount.toString());
 } catch (e) {}
}

export function getRedis() { return redis; }
