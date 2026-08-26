// accounting-redis.js

import { Redis } from '@upstash/redis';

let redis = null;

export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        console.log('✅ Redis inicializēts');
    } else {
        console.log('⚠️ Redis nav konfigurēts');
    }
    return redis;
}

export function getRedis() {
    return redis;
}
