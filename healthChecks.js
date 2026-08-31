// healthChecks.js

import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const KNOWN_ARWEAVE_TX = 'bVLEkL1SOPFCzIYi8T_QNnh17VIDp4RylU6YTwCMVRw';
const ARWEAVE_GATEWAY_URL = 'https://ar-io.dev';
const BASE_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const TURBO_PAYMENT_URL = 'https://payment.services.ar-io.dev';
const TURBO_UPLOAD_URL = 'https://upload.services.ar-io.dev';

export const checkArweaveGateway = async () => {
    try {
        const response = await fetch(`${ARWEAVE_GATEWAY_URL}/raw/${KNOWN_ARWEAVE_TX}`, {
            method: 'HEAD'
        });
        return response.ok;
    } catch {
        return false;
    }
}

export const checkBaseRPC = async () => {
    try {
        const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
        await provider.getBlockNumber();
        return true;
    } catch {
        return false;
    }
}
        return false;
    }
}

export async function checkTurboPayment() {
    try {
        const response = await fetch(`${TURBO_PAYMENT_URL}/v1/info`);
        if (!response.ok) return false;
        const data = await response.json();
        return !!data.addresses && Object.keys(data.addresses).length > 0;
    } catch {
        return false;
    }
}

export async function checkTurboUpload() {
    try {
        const response = await fetch(`${TURBO_UPLOAD_URL}/v1/info`);
        return response.ok;
    } catch {
        return false;
    }
}

export async function checkServerInternals(params) {
    const { redis, rpcUrl, operatorPrivateKey, nftAddress, subscriptionAddress } = params;

    const results = {
        redis: false,
        envVars: false,
        operatorWallet: false,
        turboSDK: false
    };

    try {
        if (redis) {
            await redis.set('test:health', 'ok');
            const value = await redis.get('test:health');
            results.redis = value === 'ok';
            await redis.del('test:health');
        }
    } catch {}

    results.envVars = !!(rpcUrl && operatorPrivateKey && nftAddress && subscriptionAddress);

    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(operatorPrivateKey, provider);
        results.operatorWallet = !!wallet.address;
    } catch {}

    try {
        const signer = new EthereumSigner(operatorPrivateKey);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            gatewayUrl: 'https://sepolia.base.org',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        results.turboSDK = !!turbo;
    } catch {}

    return results;
}

export async function checkAllServices(serverParams) {
    const results = {
        arweave: false,
        baseRPC: false,
        turboPayment: false,
        turboUpload: false,
        server: false,
        allHealthy: false
    };

    results.arweave = await checkArweaveGateway();
    results.baseRPC = await checkBaseRPC();
    results.turboPayment = await checkTurboPayment();
    results.turboUpload = await checkTurboUpload();

    const serverInternal = await checkServerInternals(serverParams);
    results.server = serverInternal.redis && serverInternal.envVars && 
                     serverInternal.operatorWallet && serverInternal.turboSDK;

    results.allHealthy = results.arweave && results.baseRPC && 
                         results.turboPayment && results.turboUpload && 
                         results.server;

    return results;
}
