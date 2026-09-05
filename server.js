// server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'fs';
import tmp from 'tmp';

import { checkAllServices } from './healthChecks.js';
import { submitBackupWithMerkle } from './merkle.js';

import {
    initRedis,
    getUserCredits,
    reserveUserCredits,
    refundUserCredits,
    getRedis,
    createJob,
    getJob,
    updateJob,
    claimPaymentTx,
    acquireJobLock,
    releaseJobLock
} from './accounting-redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const NFT_ADDRESS = process.env.NFT_ADDRESS;
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY || 'https://ar-io.dev';
const CHAIN_ID = process.env.CHAIN_ID || '0x14a34';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TURBO_TOKEN = process.env.TURBO_TOKEN || 'base-eth';
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL || 'https://upload.services.ar-io.dev';
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL || 'https://payment.services.ar-io.dev';

const MAX_REPO_FILES = Number(process.env.MAX_REPO_FILES || 5000);
const MAX_REPO_BYTES = Number(process.env.MAX_REPO_BYTES || 524288000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 104857600);
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS || 3600);
const DOWNLOAD_CONCURRENCY = 10;
const MAX_TX_AGE_SECONDS = 4 * 60 * 60;

initRedis();

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
}

function logInfo(label, value) {
    const safeValue = String(value).replace(/[\r\n\t]/g, ' ').substring(0, 100);
    console.log(`   ${label}: ${safeValue}`);
}

function logSuccess(message) {
    console.log(`   ✅ ${message}`);
}

function logError(message) {
    console.log(`   ❌ ${message}`);
}

function logWarning(message) {
    console.log(`   ⚠️ ${message}`);
}

function errorMessage(error) {
    if (error && typeof error.message === 'string') return error.message;
    return String(error);
}

function normalizeWallet(address) {
    return ethers.getAddress(address);
}

function safeWallet(address) {
    try { return normalizeWallet(address); } catch { return null; }
}

function parseChainId(value) {
    if (typeof value === 'string' && value.startsWith('0x')) return Number.parseInt(value, 16);
    return Number(value);
}

const EXPECTED_CHAIN_ID = parseChainId(CHAIN_ID);

const NFT_ABI = [
    "function mintRepository(address recipient, string calldata repository, string calldata uri) external returns (uint256)",
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external",
    "function migrateNFT(uint256 tokenId, address newOwner) external"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(bytes32 githubHash) external view returns (bool)",
    "function subscribe(bytes32 githubHash) external",
    "function subscriptionPrice() external view returns (uint256)",
    "function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)",
    "function getRemainingTime(bytes32 githubHash) external view returns (uint256)"
];

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId, address payable destination) external",
    "function balance() external view returns (uint256)",
    "function operator() external view returns (address)",
    "function isOperator(address account) external view returns (bool)"
];

async function withJobLock(jobId, fn) {
    const token = await acquireJobLock(jobId);
    if (!token) {
        throw new Error('Job jau tiek apstrādāts.');
    }
    try {
        return await fn();
    } finally {
        await releaseJobLock(jobId, token);
    }
}

// ==================================================
// TREASURY → TURBO PAYMENT
// ==================================================

async function payTreasuryToTurbo(provider, amountWei, paymentId) {
    const turboAddress = await getTurboPaymentAddress();
    const operatorWallet = getOperatorWallet(provider);
    const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
    
    const treasuryRead = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
    const isOp = await treasuryRead.isOperator(operatorWallet.address);
    if (!isOp) {
        throw new Error('Operators nav atļauts Treasury payTurbo izsaukšanai.');
    }
    
    const tx = await treasuryWrite.payTurbo(amountWei, paymentId, turboAddress);
    await tx.wait();
    
    logSuccess('Treasury → Turbo transakcija: ' + tx.hash);
    logInfo('Payment ID', paymentId);
    logInfo('Destination', turboAddress);
    logInfo('Summa', ethers.formatEther(amountWei) + ' Base ETH');
    
    return tx.hash;
}

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ==================================================
// DROŠĪBAS GALVENES
// ==================================================

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; " +
        "font-src 'self'; " +
        "connect-src 'self' https://ar-io.dev https://arweave.net https://api.github.com https://github.com https://sepolia.base.org https://base-sepolia-rpc.publicnode.com; " +
        "form-action 'self' https://github.com; " +
        "frame-ancestors 'none'; " +
        "object-src 'none';"
    );
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,
        httpOnly: true, 
        sameSite: 'lax',
        maxAge: 3600000 
    }
}));

// ==================================================
// RATE LIMITING
// ==================================================

const backupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, error: 'Pārāk daudz pieprasījumu — mēģini vēlāk.' }
});

// ==================================================
// MULTER AR TMP BIBLIOTĒKU
// ==================================================

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const tmpDir = tmp.dirSync({ 
                mode: 0o700,
                unsafeCleanup: true 
            });
            cb(null, tmpDir.name);
        },
        filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}-${file.originalname}`)
    }),
    limits: {
        fileSize: MAX_REPO_BYTES * 2
    }
});

// ==================================================
// GITHUB API AR RETRY
// ==================================================

async function fetchWithRetry(url, options, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        const response = await fetch(url, options);
        
        if (response.status === 403 || response.status === 429) {
            const remaining = response.headers.get('x-ratelimit-remaining');
            const resetTime = response.headers.get('x-ratelimit-reset');
            
            if (remaining === '0' && resetTime) {
                const resetSeconds = Number(resetTime);
                const now = Math.floor(Date.now() / 1000);
                const waitTime = Math.max(resetSeconds - now, 1);
                
                console.warn(`GitHub rate limit sasniegts. Gaida ${waitTime} sekundes...`);
                
                if (waitTime > 60) {
                    throw new Error(`GitHub rate limit sasniegts. Atgriezies pēc ${Math.ceil(waitTime / 60)} minūtēm.`);
                }
                
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                continue;
            }
        }
        
        if (response.status === 429) {
            const backoff = Math.pow(2, attempt) * 1000;
            console.warn(`HTTP 429 — mēģina pēc ${backoff}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            continue;
        }
        
        if (!response.ok) {
            throw new Error(`GitHub API kļūda: ${response.status}`);
        }
        
        return response;
    }
    
    throw new Error('GitHub API pieprasījums neizdevās pēc vairākiem mēģinājumiem.');
}

// ==================================================
// PROVIDER / OPERATOR
// ==================================================

function getProvider() {
    if (!RPC_URL) throw new Error('RPC_URL nav konfigurēts');
    return new ethers.JsonRpcProvider(RPC_URL, EXPECTED_CHAIN_ID);
}

function getOperatorWallet(provider) {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts');
    return new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
}

function getTurbo() {
    if (!OPERATOR_PRIVATE_KEY) throw new Error('OPERATOR_PRIVATE_KEY nav konfigurēts');
    return TurboFactory.authenticated({
        signer: new EthereumSigner(OPERATOR_PRIVATE_KEY),
        token: TURBO_TOKEN,
        gatewayUrl: 'https://sepolia.base.org',
        uploadServiceConfig: { url: TURBO_UPLOAD_URL },
        paymentServiceConfig: { url: TURBO_PAYMENT_URL }
    });
}

// ==================================================
// HASH FUNKCIJAS
// ==================================================

function getRepositoryHash(repoName) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName]));
}

function getGithubHash(githubUsername) {
    return ethers.keccak256(ethers.toUtf8Bytes(githubUsername));
}

function calculateMerkleRoot(files) {
    const fileHashes = files.map(file => ethers.keccak256(ethers.toUtf8Bytes(file.hash || '')));
    if (fileHashes.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes]));
}

// ==================================================
// INPUT VALIDĀCIJA
// ==================================================

function validateJobId(jobId) {
    return typeof jobId === 'string' && /^[a-f0-9-]{20,100}$/i.test(jobId);
}

function validateTokenId(tokenId) {
    try { return BigInt(tokenId) >= 0n; } catch { return false; }
}

function validateFileMetadata(files) {
    if (!Array.isArray(files)) return false;
    if (files.length > MAX_REPO_FILES) return false;
    const paths = new Set();
    for (const file of files) {
        if (!file || typeof file.path !== 'string' || typeof file.hash !== 'string') return false;
        if (file.path.length === 0 || file.path.length > 1024) return false;
        if (!/^[a-zA-Z0-9_./-]+$/.test(file.path)) return false;
        if (!/^[0-9a-f]{64}$/i.test(file.hash)) return false;
        if (paths.has(file.path)) return false;
        paths.add(file.path);
    }
    return true;
}

function metadataFingerprint(files) {
    return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(files.map(file => ({ path: file.path, hash: file.hash })))));
}

function sameMetadata(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]?.path !== b[i]?.path || String(a[i]?.hash || '').toLowerCase() !== String(b[i]?.hash || '').toLowerCase()) return false;
    }
    return true;
}

function parseIVFromFormData(iv) {
    if (Array.isArray(iv)) {
        return iv.length === 12 ? iv : null;
    }
    if (typeof iv === 'string') {
        try {
            const parsed = JSON.parse(iv);
            return Array.isArray(parsed) && parsed.length === 12 ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

// ==================================================
// TURBO
// ==================================================

async function getWincForBytes(turbo, byteSizes) {
    if (!Array.isArray(byteSizes) || byteSizes.length === 0) return { totalWinc: 0n, perFileWinc: [] };
    const costs = await turbo.getUploadCosts({ bytes: byteSizes });
    let totalWinc = 0n;
    const perFileWinc = [];
    for (let i = 0; i < costs.length; i++) {
        const winc = BigInt(String(costs[i]?.winc || '0'));
        perFileWinc.push(winc);
        totalWinc += winc;
    }
    return { totalWinc, perFileWinc };
}

async function getTurboPaymentAddress() {
    const response = await fetch(`${TURBO_PAYMENT_URL}/v1/info`);
    if (!response.ok) throw new Error(`Payment API HTTP ${response.status}`);
    const info = await response.json();
    if (!info?.addresses) throw new Error('Payment API neatgrieza addresses');
    const addressMap = {
        'base-eth': info.addresses['base-eth'] || info.addresses.ethereum,
        ethereum: info.addresses.ethereum,
        'base-usdc': info.addresses['base-usdc'] || info.addresses.usdc,
        usdc: info.addresses.usdc
    };
    const turboAddress = addressMap[TURBO_TOKEN] || info.addresses.ethereum;
    if (!turboAddress) throw new Error(`Nevar atrast adresi tokenam: ${TURBO_TOKEN}`);
    return normalizeWallet(turboAddress);
}

async function calculateTurboCost(turbo, byteCount) {
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new Error('Nederīgs byteCount');
    const costs = await turbo.getUploadCosts({ bytes: [byteCount] });
    const winc = BigInt(String(costs[0]?.winc || '0'));
    const price = await turbo.getTokenPriceForBytes({ byteCount });
    return { winc, tokenPrice: String(price.tokenPrice) };
}

// ==================================================
// GITHUB OAUTH
// ==================================================

function createOAuthState() {
    return crypto.randomBytes(32).toString('hex');
}

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.status(500).json({ success: false, error: 'GitHub OAuth nav konfigurēts' });
    const state = createOAuthState();
    req.session.oauthState = state;
    const scope = 'repo read:org';
    const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope, redirect_uri: GITHUB_REDIRECT_URI, state });
    return res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/api/github/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.redirect('/?error=no_code');
    if (!state || !req.session.oauthState || !crypto.timingSafeEqual(Buffer.from(String(state)), Buffer.from(String(req.session.oauthState)))) {
        return res.redirect('/?error=oauth_state');
    }
    delete req.session.oauthState;
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.redirect('/?error=token');
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        if (!userResponse.ok) return res.redirect('/?error=github_user');
        const userData = await userResponse.json();
        req.session.regenerate(regenerateError => {
            if (regenerateError) return res.redirect('/?error=session');
            req.session.githubToken = tokenData.access_token;
            req.session.githubUser = userData.login;
            req.session.githubAvatar = userData.avatar_url;
            return res.redirect('/?auth=success');
        });
    } catch {
        return res.redirect('/?error=oauth');
    }
});

app.get('/api/github/logout', (req, res) => {
    req.session.destroy(() => { res.json({ success: true }); });
});

app.get('/api/github/user', (req, res) => {
    if (req.session.githubUser) {
        return res.json({ success: true, user: req.session.githubUser, avatar: req.session.githubAvatar || null });
    }
    return res.json({ success: false });
});

app.get('/api/github/repos', async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts' });
    try {
        const response = await fetchWithRetry('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        const repos = await response.json();
        return res.json({ success: true, repos });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// CONFIG
// ==================================================

app.get('/api/config', (req, res) => {
    res.json({
        chainId: CHAIN_ID,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        treasuryAddress: TREASURY_ADDRESS,
        usdcAddress: USDC_ADDRESS,
        rpcUrl: RPC_URL,
        arweaveGateway: ARWEAVE_GATEWAY,
        turboToken: TURBO_TOKEN
    });
});

// ==================================================
// SUBSCRIPTION
// ==================================================

app.get('/api/subscription/status', async (req, res) => {
    try {
        const githubUser = req.session.githubUser;
        if (!githubUser) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        const provider = getProvider();
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        const githubHash = getGithubHash(githubUser);
        const isSubscribed = await subscriptionContract.isSubscribed(githubHash);
        const expiry = await subscriptionContract.getSubscriptionExpiry(githubHash);
        const remainingTime = await subscriptionContract.getRemainingTime(githubHash);
        const price = await subscriptionContract.subscriptionPrice();
        return res.json({ success: true, isSubscribed, expiry: expiry.toString(), remainingTime: remainingTime.toString(), price: price.toString(), githubUser });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// GITHUB FILES — ar concurrency un retry
// ==================================================

async function downloadSingleFile(githubToken, file) {
    const fileResponse = await fetchWithRetry(file.download_url, {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/octet-stream' }
    });
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    if (fileBuffer.length > MAX_FILE_BYTES) {
        throw new Error(`Fails ${file.path} pārsniedz izmēra limitu.`);
    }
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    return { path: file.path, size: fileBuffer.length, content: fileBuffer.toString('base64'), hash };
}

async function getRepoFiles(githubToken, owner, repo, repoPath = '', state = null) {
    const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
    const repoRegex = /^[a-zA-Z0-9_.-]{1,100}$/;
    const pathRegex = /^[a-zA-Z0-9_./-]*$/;
    
    if (!state) {
        state = { files: [], totalBytes: 0, visited: new Set() };
    }
    
    if (!owner || !repo) throw new Error('Nederīgs owner vai repo');
    if (!ownerRegex.test(owner)) throw new Error('Nederīgs owner nosaukums');
    if (!repoRegex.test(repo)) throw new Error('Nederīgs repo nosaukums');
    if (repoPath && !pathRegex.test(repoPath)) throw new Error('Nederīgs repo ceļš');
    
    const encodedPath = repoPath ? repoPath.split('/').map(part => encodeURIComponent(part)).join('/') : '';
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    const url = encodedPath ? `${baseUrl}/${encodedPath}` : baseUrl;
    
    if (state.visited.has(url)) return state.files;
    state.visited.add(url);
    
    const response = await fetchWithRetry(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    
    const contents = await response.json();
    if (!Array.isArray(contents)) return state.files;
    
    const filesToDownload = [];
    const subDirs = [];
    
    for (const item of contents) {
        if (state.files.length >= MAX_REPO_FILES) {
            throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
        }
        if (item.type === 'file') {
            const size = Number(item.size || 0);
            if (size > MAX_FILE_BYTES) {
                throw new Error(`Fails ${item.path} pārsniedz ${MAX_FILE_BYTES} bytes limitu.`);
            }
            if (item.download_url) {
                filesToDownload.push(item);
            }
        } else if (item.type === 'dir') {
            subDirs.push(item);
        }
    }
    
    for (let i = 0; i < filesToDownload.length; i += DOWNLOAD_CONCURRENCY) {
        const batch = filesToDownload.slice(i, i + DOWNLOAD_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(file => downloadSingleFile(githubToken, file))
        );
        for (const result of batchResults) {
            state.totalBytes += result.size;
            if (state.totalBytes > MAX_REPO_BYTES) {
                throw new Error(`Repo pārsniedz maksimālo izmēru (${MAX_REPO_BYTES} bytes).`);
            }
            state.files.push(result);
            if (state.files.length >= MAX_REPO_FILES) {
                throw new Error(`Repo pārsniedz maksimālo failu skaitu (${MAX_REPO_FILES}).`);
            }
        }
    }
    
    for (const dir of subDirs) {
        await getRepoFiles(githubToken, owner, repo, dir.path, state);
    }
    
    return state.files;
}

// ==================================================
// JOB AUTHORIZATION
// ==================================================

async function authorizeJob(req, job) {
    if (!job) throw new Error('Backup jobs nav atrasts vai ir beidzies.');
    const githubUser = req.session.githubUser;
    if (!githubUser) throw new Error('Nav GitHub autorizācijas.');
    if (githubUser !== job.githubUser) throw new Error('Backup jobs nepieder šim GitHub lietotājam.');
    const requestWallet = safeWallet(job.walletAddress);
    if (!requestWallet) throw new Error('Job wallet ir nederīgs.');
    return requestWallet;
}

async function verifyJobNFTOwner(provider, job) {
    const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
    const owner = await nftContract.ownerOf(job.tokenId);
    if (owner.toLowerCase() !== job.walletAddress.toLowerCase()) {
        throw new Error('NFT vairs nepieder job makam.');
    }
    return { nftContract, owner };
}

// ==================================================
// PAYMENT VERIFICATION — ar timestamp
// ==================================================

async function verifyNativePayment({ provider, txHash, expectedFrom, expectedAmountWei }) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error('Nederīgs payment tx hash.');
    }
    
    const tx = await provider.getTransaction(txHash);
    if (!tx) throw new Error('Payment transakcija nav atrasta.');
    
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error('Payment transakcija vēl nav apstiprināta.');
    if (receipt.status !== 1) throw new Error('Payment transakcija neizdevās.');
    
    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) throw new Error('Payment bloks nav atrasts.');
    
    const blockTimestamp = Number(block.timestamp);
    const now = Math.floor(Date.now() / 1000);
    const txAge = now - blockTimestamp;
    
    if (txAge > MAX_TX_AGE_SECONDS) {
        throw new Error(`Payment transakcija ir pārāk veca (${Math.floor(txAge / 3600)} stundas).`);
    }
    
    const from = safeWallet(tx.from);
    const to = tx.to ? safeWallet(tx.to) : null;
    const treasury = safeWallet(TREASURY_ADDRESS);
    
    if (!from || from.toLowerCase() !== expectedFrom.toLowerCase()) {
        throw new Error('Payment sūtītājs nesakrīt ar backup maka adresi.');
    }
    if (!to || !treasury || to.toLowerCase() !== treasury.toLowerCase()) {
        throw new Error('Payment saņēmējs nav PermRepo Treasury.');
    }
    
    const actualValue = BigInt(tx.value);
    if (actualValue !== BigInt(expectedAmountWei)) {
        throw new Error('Payment summa nesakrīt ar servera aprēķināto summu.');
    }
    
    return { 
        txHash, 
        blockNumber: receipt.blockNumber, 
        blockTimestamp,
        from, 
        to, 
        value: actualValue 
    };
}

// ==================================================
// PREPARE BACKUP — bez ZIP cenas aprēķina
// ==================================================

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        const githubUser = req.session.githubUser;
        
        logSection('📥 PREPARE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (typeof repoName !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repoName)) {
            return res.status(400).json({ success: false, error: 'Nederīgs repo nosaukums' });
        }
        const normalizedWallet = safeWallet(walletAddress);
        if (!normalizedWallet) return res.status(400).json({ success: false, error: 'Nederīga maka adrese' });
        if (!githubToken) return res.status(401).json({ success: false, error: 'Nav GitHub autorizācijas' });
        if (!githubUser) return res.status(401).json({ success: false, error: 'Nav GitHub lietotāja' });
        
        const fullRepoName = `${githubUser}/${repoName}`;
        const provider = getProvider();
        const subscriptionContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, provider);
        const githubHash = getGithubHash(githubUser);
        const isSubscribed = await subscriptionContract.isSubscribed(githubHash);
        if (!isSubscribed) return res.status(403).json({ success: false, error: 'Abonements nav aktīvs' });
        
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const repoHash = getRepositoryHash(fullRepoName);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        if (tokenId === 0n) return res.status(400).json({ success: false, error: 'Nav NFT šim repo' });
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== normalizedWallet.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'NFT nepieder šim makam' });
        }
        
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        
        let previousPaths = {};
        let previousHistory = [];
        let previousManifestId = null;
        let previousBackupNumber = null;
        let previousEncryptionIVs = {};
        
        if (backupCount > 0) {
            const manifestURI = await nftContract.getManifestURI(tokenId);
            if (manifestURI && manifestURI.startsWith('ar://')) {
                previousManifestId = manifestURI.slice(5);
                try {
                    const manifestResponse = await fetch(`${ARWEAVE_GATEWAY}/raw/${encodeURIComponent(previousManifestId)}`);
                    if (manifestResponse.ok) {
                        const previousManifest = await manifestResponse.json();
                        if (previousManifest && typeof previousManifest.paths === 'object') previousPaths = previousManifest.paths;
                        if (Array.isArray(previousManifest?.history)) previousHistory = previousManifest.history;
                        if (previousManifest?.metadata?.backupNumber !== undefined) previousBackupNumber = previousManifest.metadata.backupNumber;
                        if (previousManifest?.encryption?.ivs && typeof previousManifest.encryption.ivs === 'object') previousEncryptionIVs = previousManifest.encryption.ivs;
                    }
                } catch (error) {
                    logWarning('Neizdevās iegūt iepriekšējo manifestu: ' + errorMessage(error));
                }
            }
        }
        
        const currentFiles = await getRepoFiles(githubToken, githubUser, repoName);
        if (currentFiles.length === 0) return res.status(400).json({ success: false, error: 'Nav failu repo' });
        
        const changedFiles = [];
        const unchangedFiles = {};
        
        for (const file of currentFiles) {
            const previousFile = previousPaths[file.path];
            if (previousFile && previousFile.zipId && previousFile.hash && previousFile.hash === file.hash) {
                unchangedFiles[file.path] = { zipId: previousFile.zipId, size: file.size, hash: file.hash };
            } else {
                changedFiles.push(file);
            }
        }
        
        if (changedFiles.length === 0) {
            return res.json({ success: true, jobId: null, files: [], unchangedFiles, fileCount: 0, totalBytes: 0, backupCount, message: 'Nav izmaiņu' });
        }
        
        const jobId = crypto.randomUUID();
        
        const job = {
            version: 1,
            jobId,
            githubUser,
            repoName,
            fullRepoName,
            walletAddress: normalizedWallet,
            tokenId: tokenId.toString(),
            backupCount,
            changedFiles: changedFiles.map(file => ({ path: file.path, hash: file.hash, size: file.size })),
            unchangedFiles,
            previousHistory,
            previousManifestId,
            previousBackupNumber,
            previousEncryptionIVs,
            status: 'prepared',
            zipUploaded: false,
            zipTxId: null,
            manifestPrepared: false,
            manifestUploaded: false,
            manifestTxId: null,
            manifest: null,
            filePaymentTxHash: null,
            manifestPaymentTxHash: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        await createJob(jobId, job, JOB_TTL_SECONDS);
        
        return res.json({
            success: true,
            jobId,
            repoName: fullRepoName,
            tokenId: tokenId.toString(),
            files: changedFiles,
            unchangedFiles,
            previousHistory,
            previousManifestId,
            previousBackupNumber,
            previousEncryptionIVs,
            fileCount: changedFiles.length,
            totalBytes: changedFiles.reduce((sum, file) => sum + Number(file.size), 0),
            backupCount
        });
    } catch (error) {
        logSection('❌ BACKUP PREPARE ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// EXECUTE BACKUP — ZIP — VIENS Turbo aprēķins
// ==================================================

app.post('/api/execute-backup', backupLimiter, upload.single('file'), async (req, res) => {
    const { jobId, iv, fileMetadata, paymentTxHash } = req.body;
    
    try {
        if (!validateJobId(jobId)) return res.status(400).json({ success: false, error: 'Nederīgs jobId' });
        
        const job = await getJob(jobId);
        const wallet = await authorizeJob(req, job);
        const provider = getProvider();
        await verifyJobNFTOwner(provider, job);
        
        if (!req.file || !req.file.path) {
            return res.status(400).json({ success: false, error: 'Šifrēts ZIP ir obligāts' });
        }
        
        const zipBuffer = fs.readFileSync(req.file.path);
        fs.unlinkSync(req.file.path);
        
        if (zipBuffer.length > MAX_REPO_BYTES * 2) {
            return res.status(413).json({ success: false, error: 'Šifrētais ZIP ir pārāk liels.' });
        }
        
        const parsedIV = parseIVFromFormData(iv);
        if (!parsedIV) {
            return res.status(400).json({ success: false, error: 'Nederīgs AES-GCM IV.' });
        }
        
        let parsedFileMetadata;
        try {
            parsedFileMetadata = typeof fileMetadata === 'string' ? JSON.parse(fileMetadata) : fileMetadata;
        } catch {
            return res.status(400).json({ success: false, error: 'Nederīgs fileMetadata formāts.' });
        }
        
        if (!validateFileMetadata(parsedFileMetadata)) {
            return res.status(400).json({ success: false, error: 'Nederīgs fileMetadata.' });
        }
        
        if (!sameMetadata(parsedFileMetadata, job.changedFiles)) {
            return res.status(400).json({ success: false, error: 'Failu metadata neatbilst prepare backup rezultātam.' });
        }
        
        if (job.zipUploaded && job.zipTxId) {
            return res.json({ success: true, step: 'zip_uploaded', zipTxId: job.zipTxId, idempotent: true });
        }
        
        return await withJobLock(jobId, async () => {
            const currentJob = await getJob(jobId);
            
            if (currentJob.zipUploaded && currentJob.zipTxId) {
                return res.json({ success: true, step: 'zip_uploaded', zipTxId: currentJob.zipTxId, idempotent: true });
            }
            
            // PIRMAIS PIEPRASĪJUMS — nav paymentTxHash
            if (!paymentTxHash) {
                // VIENS Turbo aprēķins
                const turbo = getTurbo();
                const { winc: fileWinc, tokenPrice: fullFileCostEth } = await calculateTurboCost(turbo, zipBuffer.length);
                
                const userCredits = await getUserCredits(wallet);
                
                logSection('📤 EXECUTE BACKUP — ZIP');
                logInfo('Job', jobId);
                logInfo('Repo', currentJob.fullRepoName);
                logInfo('ZIP bytes', zipBuffer.length);
                logInfo('Precīza cena', fullFileCostEth + ' ETH');
                logInfo('Winc', fileWinc.toString());
                
                if (userCredits >= fileWinc) {
                    // Kredīti pietiek — uzreiz rezervē un upload
                    const reserved = await reserveUserCredits(wallet, fileWinc);
                    if (!reserved) {
                        return res.status(400).json({ success: false, error: 'Redis kredītu rezervēšana neizdevās.' });
                    }
                    
                    await updateJob(jobId, {
                        fileWinc: fileWinc.toString(),
                        fullFileCostEth,
                        fileCostEth: '0',
                        zipStartedAt: Date.now(),
                        updatedAt: Date.now()
                    });
                    
                    try {
                        const zipResult = await turbo.uploadFile({
                            fileStreamFactory: () => Readable.from(zipBuffer),
                            fileSizeFactory: () => zipBuffer.length,
                            dataItemOpts: {
                                tags: [
                                    { name: 'App-Name', value: 'PermRepo' },
                                    { name: 'Repo', value: currentJob.fullRepoName },
                                    { name: 'Type', value: 'backup-archive' },
                                    { name: 'Content-Type', value: 'application/zip' },
                                    { name: 'Encrypted', value: 'true' },
                                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                                ]
                            }
                        });
                        
                        await updateJob(jobId, {
                            zipUploaded: true,
                            zipTxId: zipResult.id,
                            status: 'zip_uploaded',
                            updatedAt: Date.now()
                        });
                        
                        return res.json({ success: true, step: 'zip_uploaded', zipTxId: zipResult.id, iv: parsedIV });
                    } catch (uploadError) {
                        await refundUserCredits(wallet, fileWinc);
                        await updateJob(jobId, { status: 'zip_failed', updatedAt: Date.now() });
                        logError('Turbo ZIP upload failed: ' + errorMessage(uploadError));
                        return res.status(500).json({ success: false, error: 'Augšupielāde neizdevās: ' + errorMessage(uploadError) });
                    }
                }
                
                // Kredītu nepietiek — saglabā cenu un prasa maksājumu
                await updateJob(jobId, {
                    fileWinc: fileWinc.toString(),
                    fullFileCostEth,
                    fileCostEth: fullFileCostEth,
                    updatedAt: Date.now()
                });
                
                return res.json({
                    success: false,
                    paymentRequired: true,
                    requiredPaymentEth: fullFileCostEth,
                    fileWinc: fileWinc.toString(),
                    zipSize: zipBuffer.length,
                    error: 'Nepieciešama Treasury iemaksas transakcija.'
                });
            }
            
            // OTRAIS PIEPRASĪJUMS — ar paymentTxHash
            // IZMANTO SAGLABĀTO CENU, NEIZSAUC Turbo
            const fileWinc = BigInt(currentJob.fileWinc || '0');
            const fullFileCostEth = currentJob.fullFileCostEth;
            
            logSection('📤 EXECUTE BACKUP — ZIP (payment)');
            logInfo('Job', jobId);
            logInfo('ZIP bytes', zipBuffer.length);
            logInfo('Saglabātā cena', fullFileCostEth + ' ETH');
            
            const expectedWei = ethers.parseEther(fullFileCostEth);
            await verifyNativePayment({ provider, txHash: paymentTxHash, expectedFrom: wallet, expectedAmountWei: expectedWei });
            const claimed = await claimPaymentTx(paymentTxHash, { jobId, stage: 'zip', walletAddress: wallet, amountWei: expectedWei.toString() });
            if (!claimed) throw new Error('Šī payment transakcija jau ir izmantota.');
            
            // TREASURY → TURBO PAYMENT
            const paymentId = ethers.id(`${jobId}-zip`);
            await payTreasuryToTurbo(provider, expectedWei, paymentId);
            
            await updateJob(jobId, {
                filePaymentTxHash: paymentTxHash,
                zipStartedAt: Date.now(),
                updatedAt: Date.now()
            });
            
            const turbo = getTurbo();
            
            try {
                const zipResult = await turbo.uploadFile({
                    fileStreamFactory: () => Readable.from(zipBuffer),
                    fileSizeFactory: () => zipBuffer.length,
                    dataItemOpts: {
                        tags: [
                            { name: 'App-Name', value: 'PermRepo' },
                            { name: 'Repo', value: currentJob.fullRepoName },
                            { name: 'Type', value: 'backup-archive' },
                            { name: 'Content-Type', value: 'application/zip' },
                            { name: 'Encrypted', value: 'true' },
                            { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                        ]
                    }
                });
                
                await updateJob(jobId, {
                    zipUploaded: true,
                    zipTxId: zipResult.id,
                    status: 'zip_uploaded',
                    updatedAt: Date.now()
                });
                
                return res.json({ success: true, step: 'zip_uploaded', zipTxId: zipResult.id, iv: parsedIV });
            } catch (uploadError) {
                await updateJob(jobId, { status: 'zip_failed', updatedAt: Date.now() });
                logError('Turbo ZIP upload failed: ' + errorMessage(uploadError));
                return res.status(500).json({ success: false, error: 'Augšupielāde neizdevās: ' + errorMessage(uploadError) });
            }
        });
    } catch (error) {
        logSection('❌ EXECUTE BACKUP ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// MANIFEST BUILDER
// ==================================================

function buildManifest(job) {
    const history = Array.isArray(job.previousHistory) ? [...job.previousHistory] : [];
    
    if (job.previousManifestId) {
        const alreadyExists = history.some(entry => entry && entry.manifestId === job.previousManifestId);
        if (!alreadyExists) {
            history.push({
                backupNumber: job.previousBackupNumber || history.length,
                manifestId: job.previousManifestId,
                url: `${ARWEAVE_GATEWAY}/raw/${encodeURIComponent(job.previousManifestId)}`
            });
        }
    }
    
    history.sort((a, b) => Number(b?.backupNumber || 0) - Number(a?.backupNumber || 0));
    
    const encryptionIVs = Object.create(null);
    
    if (job.previousEncryptionIVs && typeof job.previousEncryptionIVs === 'object') {
        for (const [id, value] of Object.entries(job.previousEncryptionIVs)) {
            if (typeof id === 'string' && Array.isArray(value)) {
                encryptionIVs[id] = value;
            }
        }
    }
    
    if (Array.isArray(job.currentIV) && job.currentIV.length === 12) {
        encryptionIVs[job.zipTxId] = job.currentIV;
    }
    
    const manifest = {
        metadata: {
            repo: job.fullRepoName,
            backupNumber: Number(job.backupCount) + 1,
            timestamp: new Date().toISOString(),
            generatedBy: 'PermRepo v1.0.0'
        },
        manifest: 'arweave/paths',
        version: '0.2.0',
        encryption: { ivs: encryptionIVs },
        archive: {
            id: job.zipTxId,
            url: `${ARWEAVE_GATEWAY}/raw/${encodeURIComponent(job.zipTxId)}`,
            contains: job.changedFiles.map(file => ({ path: file.path, hash: file.hash }))
        },
        paths: {},
        history
    };
    
    for (const file of job.changedFiles) {
        manifest.paths[file.path] = { zipId: job.zipTxId, hash: file.hash };
    }
    
    for (const [filePath, info] of Object.entries(job.unchangedFiles || {})) {
        if (info && info.zipId && info.hash) {
            manifest.paths[filePath] = { zipId: info.zipId, hash: info.hash };
        }
    }
    
    const manifestPaths = Object.keys(manifest.paths);
    if (manifestPaths.length > 0) {
        manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
    }
    
    return manifest;
}

// ==================================================
// FINALIZE MANIFEST
// ==================================================

app.post('/api/finalize-manifest', backupLimiter, async (req, res) => {
    const { jobId, zipTxId, fileMetadata, unchangedFiles, iv, paymentTxHash } = req.body;
    
    try {
        if (!validateJobId(jobId)) return res.status(400).json({ success: false, error: 'Nederīgs jobId' });
        
        const job = await getJob(jobId);
        const wallet = await authorizeJob(req, job);
        const provider = getProvider();
        await verifyJobNFTOwner(provider, job);
        
        if (job.zipTxId !== zipTxId) {
            return res.status(400).json({ success: false, error: 'ZIP ID neatbilst backup jobam.' });
        }
        
        const parsedIV = parseIVFromFormData(iv);
        if (!parsedIV) {
            return res.status(400).json({ success: false, error: 'Nederīgs AES-GCM IV.' });
        }
        
        let parsedFileMetadata;
        try {
            parsedFileMetadata = typeof fileMetadata === 'string' ? JSON.parse(fileMetadata) : fileMetadata;
        } catch {
            return res.status(400).json({ success: false, error: 'Nederīgs fileMetadata formāts.' });
        }
        
        if (!validateFileMetadata(parsedFileMetadata)) {
            return res.status(400).json({ success: false, error: 'Nederīgs fileMetadata.' });
        }
        
        if (!sameMetadata(parsedFileMetadata, job.changedFiles)) {
            return res.status(400).json({ success: false, error: 'fileMetadata neatbilst jobam.' });
        }
        
        let parsedUnchangedFiles;
        try {
            parsedUnchangedFiles = typeof unchangedFiles === 'string' ? JSON.parse(unchangedFiles) : unchangedFiles;
        } catch {
            return res.status(400).json({ success: false, error: 'Nederīgs unchangedFiles formāts.' });
        }
        
        if (JSON.stringify(parsedUnchangedFiles || {}) !== JSON.stringify(job.unchangedFiles || {})) {
            return res.status(400).json({ success: false, error: 'unchangedFiles neatbilst jobam.' });
        }
        
        if (job.manifestUploaded && job.manifestTxId && job.manifest) {
            return res.json({
                success: true,
                manifestTxId: job.manifestTxId,
                manifest: job.manifest,
                manifestCostEth: job.manifestCostEth || '0',
                manifestWinc: job.manifestWinc || '0',
                backupNumber: Number(job.backupCount) + 1,
                idempotent: true
            });
        }
        
        return await withJobLock(jobId, async () => {
            const currentJob = await getJob(jobId);
            
            if (!currentJob.manifestPrepared) {
                const mutableJob = { ...currentJob, currentIV: parsedIV };
                const manifest = buildManifest(mutableJob);
                const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
                const manifestSize = manifestBuffer.length;
                const turbo = getTurbo();
                const { winc: manifestWinc, tokenPrice: manifestCostEth } = await calculateTurboCost(turbo, manifestSize);
                const userCredits = await getUserCredits(wallet);
                const useCredits = userCredits >= manifestWinc;
                
                const jobUpdate = {
                    manifestPrepared: true,
                    manifest: JSON.parse(JSON.stringify(manifest)),
                    manifestSize,
                    manifestWinc: manifestWinc.toString(),
                    fullManifestCostEth: manifestCostEth,
                    manifestCostEth: useCredits ? '0' : manifestCostEth,
                    currentIV: parsedIV,
                    creditsReservedForManifest: false,
                    updatedAt: Date.now()
                };
                
                await updateJob(jobId, jobUpdate);
                
                const paymentRequired = !useCredits && BigInt(ethers.parseEther(manifestCostEth)) > 0n;
                
                if (paymentRequired && !paymentTxHash) {
                    return res.json({
                        success: false,
                        paymentRequired: true,
                        requiredPaymentEth: manifestCostEth,
                        manifest: manifest,
                        manifestWinc: manifestWinc.toString(),
                        manifestSize,
                        backupNumber: Number(currentJob.backupCount) + 1
                    });
                }
            }
            
            const refreshedJob = await getJob(jobId);
            if (!refreshedJob) throw new Error('Backup job pazuda.');
            
            let creditsReserved = false;
            let paymentVerified = false;
            
            const manifestWinc = BigInt(refreshedJob.manifestWinc || '0');
            const fullManifestCostEth = refreshedJob.fullManifestCostEth || refreshedJob.manifestCostEth || '0';
            
            if (refreshedJob.manifestCostEth !== '0') {
                if (!paymentTxHash) {
                    return res.json({
                        success: false,
                        paymentRequired: true,
                        requiredPaymentEth: fullManifestCostEth,
                        manifest: refreshedJob.manifest,
                        manifestWinc: manifestWinc.toString(),
                        manifestSize: refreshedJob.manifestSize,
                        backupNumber: Number(refreshedJob.backupCount) + 1
                    });
                }
                
                const expectedWei = ethers.parseEther(fullManifestCostEth);
                await verifyNativePayment({ provider, txHash: paymentTxHash, expectedFrom: wallet, expectedAmountWei: expectedWei });
                const claimed = await claimPaymentTx(paymentTxHash, { jobId, stage: 'manifest', walletAddress: wallet, amountWei: expectedWei.toString() });
                if (!claimed) throw new Error('Šī payment transakcija jau ir izmantota.');
                paymentVerified = true;
                
                // TREASURY → TURBO PAYMENT
                const paymentId = ethers.id(`${jobId}-manifest`);
                await payTreasuryToTurbo(provider, expectedWei, paymentId);
            } else {
                const reserved = await reserveUserCredits(wallet, manifestWinc);
                if (!reserved) {
                    return res.json({
                        success: false,
                        paymentRequired: true,
                        requiredPaymentEth: fullManifestCostEth,
                        manifest: refreshedJob.manifest,
                        manifestWinc: manifestWinc.toString(),
                        manifestSize: refreshedJob.manifestSize,
                        backupNumber: Number(refreshedJob.backupCount) + 1,
                        error: 'Redis kredītu vairs nepietiek. Nepieciešama Treasury iemaksa.'
                    });
                }
                creditsReserved = true;
            }
            
            const turbo = getTurbo();
            const manifestBuffer = Buffer.from(JSON.stringify(refreshedJob.manifest), 'utf8');
            
            await updateJob(jobId, {
                manifestPaymentTxHash: paymentVerified ? paymentTxHash : null,
                creditsReservedForManifest: creditsReserved,
                manifestStartedAt: Date.now(),
                updatedAt: Date.now()
            });
            
            try {
                const manifestResult = await turbo.uploadFile({
                    fileStreamFactory: () => Readable.from(manifestBuffer),
                    fileSizeFactory: () => manifestBuffer.length,
                    dataItemOpts: {
                        tags: [
                            { name: 'App-Name', value: 'PermRepo' },
                            { name: 'Type', value: 'path-manifest' },
                            { name: 'Repo', value: refreshedJob.fullRepoName },
                            { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                            { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                        ]
                    }
                });
                
                await updateJob(jobId, {
                    manifestUploaded: true,
                    manifestTxId: manifestResult.id,
                    status: 'manifest_uploaded',
                    creditsReservedForManifest: false,
                    updatedAt: Date.now()
                });
                
                return res.json({
                    success: true,
                    manifestTxId: manifestResult.id,
                    manifest: refreshedJob.manifest,
                    manifestCostEth: refreshedJob.manifestCostEth || '0',
                    manifestWinc: manifestWinc.toString(),
                    backupNumber: Number(refreshedJob.backupCount) + 1
                });
            } catch (uploadError) {
                if (creditsReserved) {
                    await refundUserCredits(wallet, manifestWinc);
                }
                await updateJob(jobId, {
                    creditsReservedForManifest: false,
                    status: 'manifest_failed',
                    updatedAt: Date.now()
                });
                logError('Manifest upload failed: ' + errorMessage(uploadError));
                return res.status(500).json({ success: false, error: 'Manifesta augšupielāde neizdevās.' });
            }
        });
    } catch (error) {
        logSection('❌ FINALIZE MANIFEST ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// FINALIZE BACKUP
// ==================================================

app.post('/api/finalize-backup', backupLimiter, async (req, res) => {
    try {
        const { jobId, tokenId, manifestTxId, fileMetadata, deadline, signature } = req.body;
        
        if (!validateJobId(jobId)) return res.status(400).json({ success: false, error: 'Nederīgs jobId' });
        
        const job = await getJob(jobId);
        const wallet = await authorizeJob(req, job);
        
        if (!validateTokenId(tokenId)) return res.status(400).json({ success: false, error: 'Nederīgs tokenId' });
        if (String(tokenId) !== String(job.tokenId)) return res.status(400).json({ success: false, error: 'tokenId neatbilst backup jobam.' });
        if (typeof manifestTxId !== 'string' || !/^[a-zA-Z0-9_-]{20,100}$/.test(manifestTxId)) return res.status(400).json({ success: false, error: 'Nederīgs manifestTxId' });
        if (!validateFileMetadata(fileMetadata)) return res.status(400).json({ success: false, error: 'Nederīgs fileMetadata' });
        if (!sameMetadata(fileMetadata, job.changedFiles)) return res.status(400).json({ success: false, error: 'fileMetadata neatbilst backup jobam.' });
        if (!Number.isInteger(Number(deadline))) return res.status(400).json({ success: false, error: 'Nederīgs deadline.' });
        if (Number(deadline) <= Math.floor(Date.now() / 1000)) return res.status(400).json({ success: false, error: 'Signature deadline ir beidzies.' });
        if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ success: false, error: 'Nederīga signature.' });
        if (!job.manifestUploaded || job.manifestTxId !== manifestTxId) return res.status(400).json({ success: false, error: 'Manifests vēl nav veiksmīgi augšupielādēts.' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const nftOwner = await nftContract.ownerOf(job.tokenId);
        if (nftOwner.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ success: false, error: 'NFT nepieder šim makam.' });
        
        const nonce = await nftContract.getNonce(job.tokenId);
        const backupCount = await nftContract.getBackupCount(job.tokenId);
        const backupNumber = backupCount + 1n;
        const manifestURI = `ar://${manifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        const merkleRoot = calculateMerkleRoot(job.changedFiles);
        
        const domain = { name: 'PermRepo', version: '1', chainId: EXPECTED_CHAIN_ID, verifyingContract: NFT_ADDRESS };
        const types = {
            AddBackup: [
                { name: 'tokenId', type: 'uint256' },
                { name: 'backupNumber', type: 'uint256' },
                { name: 'manifestHash', type: 'bytes32' },
                { name: 'merkleRoot', type: 'bytes32' },
                { name: 'deadline', type: 'uint256' },
                { name: 'nonce', type: 'uint256' }
            ]
        };
        
        const typedValue = {
            tokenId: BigInt(job.tokenId),
            backupNumber,
            manifestHash,
            merkleRoot,
            deadline: BigInt(deadline),
            nonce
        };
        
        let recovered;
        try {
            recovered = ethers.verifyTypedData(domain, types, typedValue, signature);
        } catch {
            return res.status(400).json({ success: false, error: 'EIP-712 signature nav derīga.' });
        }
        
        if (recovered.toLowerCase() !== nftOwner.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'Signature nav NFT īpašnieka parakstīta.' });
        }
        
        await updateJob(jobId, {
            finalizationAttemptedAt: Date.now(),
            signedMerkleRoot: merkleRoot,
            signedManifestHash: manifestHash,
            signedBackupNumber: backupNumber.toString(),
            updatedAt: Date.now()
        });
        
        const merkleTxHash = await submitBackupWithMerkle({
            tokenId: job.tokenId,
            manifestTxId,
            files: job.changedFiles,
            deadline,
            signature,
            nftContract: new ethers.Contract(NFT_ADDRESS, NFT_ABI, getOperatorWallet(provider)),
            readContract: nftContract
        });
        
        await updateJob(jobId, {
            status: 'completed',
            merkleTxHash,
            completedAt: Date.now(),
            updatedAt: Date.now()
        });
        
        logSuccess('Merkle sakne iesniegta!');
        logInfo('Transakcija', merkleTxHash);
        
        return res.json({ success: true, merkleTxHash });
    } catch (error) {
        logError('Finalize sign kļūda: ' + errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// KREDĪTU STATUS
// ==================================================

app.get('/api/credits/status', async (req, res) => {
    try {
        const wallet = safeWallet(req.query.walletAddress);
        if (!wallet) return res.status(400).json({ success: false, error: 'Nederīga walletAddress' });
        
        const githubUser = req.session.githubUser;
        if (!githubUser) return res.status(401).json({ success: false, error: 'Nav autorizācijas' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        const repoParam = typeof req.query.repo === 'string' ? req.query.repo : null;
        if (!repoParam) return res.status(400).json({ success: false, error: 'repo parametrs ir obligāts.' });
        
        const fullRepoName = `${githubUser}/${repoParam}`;
        const repoHash = getRepositoryHash(fullRepoName);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        if (tokenId === 0n) return res.status(404).json({ success: false, error: 'Nav NFT šim repo.' });
        
        const owner = await nftContract.ownerOf(tokenId);
        if (owner.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ success: false, error: 'Wallet nepieder šī repo NFT.' });
        
        const credits = await getUserCredits(wallet);
        
        logSection('💰 REDIS KREDĪTU PĀRBAUDE');
        logInfo('Wallet', wallet);
        logInfo('Kredīti', `${credits} winc`);
        
        return res.json({ success: true, walletAddress: wallet, credits: credits.toString() });
    } catch (error) {
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// HEALTH
// ==================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        configured: {
            rpc: !!RPC_URL,
            operatorKey: !!OPERATOR_PRIVATE_KEY,
            treasury: !!TREASURY_ADDRESS,
            nft: !!NFT_ADDRESS,
            subscription: !!SUBSCRIPTION_ADDRESS,
            usdc: !!USDC_ADDRESS,
            githubOAuth: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_REDIRECT_URI),
            redis: !!getRedis()
        }
    });
});

// ==================================================
// CATCH-ALL
// ==================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================================
// START
// ==================================================

app.listen(PORT, () => {
    logSection('🚀 PERMAREPO SERVERIS');
    logInfo('Ports', PORT);
    logInfo('TREASURY_ADDRESS', TREASURY_ADDRESS || '❌ NAV');
    logInfo('NFT_ADDRESS', NFT_ADDRESS || '❌ NAV');
    logInfo('SUBSCRIPTION_ADDRESS', SUBSCRIPTION_ADDRESS || '❌ NAV');
    logInfo('USDC_ADDRESS', USDC_ADDRESS || '❌ NAV');
    logInfo('Redis', getRedis() ? '✅ IR' : '❌ NAV');
    console.log('='.repeat(60) + '\n');
});
