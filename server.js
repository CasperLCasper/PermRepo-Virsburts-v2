// server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

import { checkAllServices } from './healthChecks.js';
import { submitBackupWithMerkle } from './merkle.js';
import { initRedis, getUserCredits, setUserCredits, getRedis } from './accounting-redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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

initRedis();

function logSection(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60));
}

function logInfo(label, value) {
    console.log(`   ${label}: ${value}`);
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

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 3600000 }
}));

function getProvider() {
    if (!RPC_URL) throw new Error('RPC_URL nav konfigurēts');
    return new ethers.JsonRpcProvider(RPC_URL);
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

function errorMessage(error) {
    return error && typeof error.message === 'string' ? error.message : String(error);
}

function getRepositoryHash(repoName) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName]));
}

function getGithubHash(githubUsername) {
    return ethers.keccak256(ethers.toUtf8Bytes(githubUsername));
}

async function getWincForBytes(turbo, byteSizes) {
    if (!Array.isArray(byteSizes) || byteSizes.length === 0) {
        return { totalWinc: 0n, perFileWinc: [] };
    }
    
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

async function getEthForBytes(turbo, totalBytes) {
    if (totalBytes <= 0) return '0';
    
    try {
        const { totalWinc } = await getWincForBytes(turbo, [totalBytes]);
        if (totalWinc === 0n) return '0';
    } catch (e) {
        logWarning('getUploadCosts kļūda: ' + errorMessage(e));
    }
    
    const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytes });
    return String(tokenPrice);
}

async function getTurboPaymentAddress() {
    try {
        const response = await fetch(`${TURBO_PAYMENT_URL}/v1/info`);
        if (!response.ok) throw new Error(`Payment API HTTP ${response.status}`);
        
        const info = await response.json();
        if (!info.addresses) throw new Error('Payment API neatgrieza addresses');
        
        const addressMap = {
            'base-eth': info.addresses['base-eth'] || info.addresses['ethereum'],
            'ethereum': info.addresses['ethereum'],
            'base-usdc': info.addresses['base-usdc'] || info.addresses['usdc'],
            'usdc': info.addresses['usdc']
        };
        
        const turboAddress = addressMap[TURBO_TOKEN] || info.addresses['ethereum'];
        if (!turboAddress) throw new Error('Nevar atrast adresi tokenam: ' + TURBO_TOKEN);
        
        return turboAddress;
    } catch (error) {
        throw error;
    }
}

// ==================================================
// GITHUB OAUTH
// ==================================================

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) return res.status(500).json({ success: false, error: 'GitHub OAuth nav konfigurēts' });
    const scope = 'repo read:org';
    const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope, redirect_uri: GITHUB_REDIRECT_URI });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/api/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');
    
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI })
        });
        
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.redirect('/?error=token');
        
        req.session.githubToken = tokenData.access_token;
        
        const userResponse = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        const userData = await userResponse.json();
        req.session.githubUser = userData.login;
        req.session.githubAvatar = userData.avatar_url;
        
        res.redirect('/?auth=success');
    } catch (error) {
        res.redirect('/?error=oauth');
    }
});

app.get('/api/github/logout', (req, res) => {
    req.session.destroy(() => { res.json({ success: true }); });
});

app.get('/api/github/user', (req, res) => {
    if (req.session.githubUser) {
        res.json({ success: true, user: req.session.githubUser, avatar: req.session.githubAvatar || null });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/github/repos', async (req, res) => {
    const githubToken = req.session.githubToken;
    if (!githubToken) return res.status(401).json({ success: false, error: 'Nav autorizēts' });
    
    try {
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' }
        });
        
        if (!response.ok) throw new Error(`GitHub API kļūda: ${response.status}`);
        const repos = await response.json();
        
        res.json({ success: true, repos });
    } catch (error) {
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

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
        
        res.json({
            success: true,
            isSubscribed,
            expiry: expiry.toString(),
            remainingTime: remainingTime.toString(),
            price: price.toString(),
            githubUser
        });
    } catch (error) {
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

async function getRepoFiles(githubToken, owner, repo, repoPath = '') {
    if (!owner || !repo) throw new Error('Nederīgs owner vai repo');
    
    const files = [];
    const encodedPath = repoPath ? repoPath.split('/').map(part => encodeURIComponent(part)).join('/') : '';
    const url = encodedPath
        ? `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`
        : `https://api.github.com/repos/${owner}/${repo}/contents`;
    
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    
    if (!response.ok) throw new Error(`GitHub API kļūda: ${response.status} (${url})`);
    
    const contents = await response.json();
    if (!Array.isArray(contents)) return files;
    
    for (const item of contents) {
        if (item.type === 'file') {
            const size = Number(item.size || 0);
            if (size > 104857600) continue;
            if (!item.download_url) continue;
            
            const fileResponse = await fetch(item.download_url, {
                headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/octet-stream' }
            });
            
            if (!fileResponse.ok) continue;
            
            const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
            
            files.push({ path: item.path, size: fileBuffer.length, content: fileBuffer.toString('base64'), hash });
        } else if (item.type === 'dir') {
            const subFiles = await getRepoFiles(githubToken, owner, repo, item.path);
            files.push(...subFiles);
        }
    }
    
    return files;
}

// ==================================================
// PREPARE BACKUP
// ==================================================

app.post('/api/prepare-backup', async (req, res) => {
    try {
        const { repoName, walletAddress } = req.body;
        const githubToken = req.session.githubToken;
        const githubUser = req.session.githubUser;
        
        logSection('📥 PREPARE BACKUP');
        logInfo('Repo', repoName);
        logInfo('Wallet', walletAddress);
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repo nosaukuma' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav maka adreses' });
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
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
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
                    const manifestResponse = await fetch(`${ARWEAVE_GATEWAY}/raw/${previousManifestId}`);
                    if (manifestResponse.ok) {
                        const previousManifest = await manifestResponse.json();
                        if (previousManifest.paths) previousPaths = previousManifest.paths;
                        if (previousManifest.history) previousHistory = previousManifest.history;
                        if (previousManifest.metadata && previousManifest.metadata.backupNumber) previousBackupNumber = previousManifest.metadata.backupNumber;
                        if (previousManifest.encryption && previousManifest.encryption.ivs) previousEncryptionIVs = previousManifest.encryption.ivs;
                    }
                } catch (e) {
                    logWarning('Neizdevās iegūt iepriekšējo manifestu: ' + errorMessage(e));
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
            return res.json({
                success: true,
                files: [],
                unchangedFiles,
                fileCount: 0,
                totalBytes: 0,
                fileCostEth: '0',
                backupCount,
                message: 'Nav izmaiņu'
            });
        }
        
        const totalFileBytes = changedFiles.reduce((sum, file) => sum + file.size, 0);
        const estimatedZipSize = Math.ceil(totalFileBytes * 1.1);
        
        const turbo = getTurbo();
        const { totalWinc: fileWinc } = await getWincForBytes(turbo, [estimatedZipSize]);
        const fileCostEth = await getEthForBytes(turbo, estimatedZipSize);
        
        const userCredits = await getUserCredits(walletAddress);
        let newUserCredits = 0n;
        if (userCredits >= fileWinc) newUserCredits = userCredits - fileWinc;
        
        res.json({
            success: true,
            repoName: fullRepoName,
            tokenId: tokenId.toString(),
            files: changedFiles,
            unchangedFiles,
            previousHistory,
            previousManifestId,
            previousBackupNumber,
            previousEncryptionIVs,
            fileCount: changedFiles.length,
            totalBytes: totalFileBytes,
            estimatedZipSize,
            fileWinc: fileWinc.toString(),
            fileCostEth,
            newUserCredits: newUserCredits.toString(),
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
// EXECUTE BACKUP — 1. POSMS: ZIP apmaksa + ZIP augšupielāde
// ==================================================

app.post('/api/execute-backup', async (req, res) => {
    try {
        const { 
            repoName, tokenId, fileCostEth, walletAddress, newUserCredits, 
            encryptedZip, iv, fileMetadata
        } = req.body;
        
        logSection('📤 EXECUTE BACKUP — 1. POSMS: ZIP');
        logInfo('Repo', repoName);
        logInfo('Token ID', tokenId);
        logInfo('Failu izmaksas', fileCostEth + ' ETH');
        logInfo('Šifrēts ZIP', encryptedZip ? '✅ JĀ' : '❌ NĒ');
        logInfo('Metadata faili', fileMetadata ? fileMetadata.length : 0);
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId' });
        if (fileCostEth === undefined) return res.status(400).json({ success: false, error: 'Nav fileCostEth' });
        
        if (!encryptedZip || !Array.isArray(encryptedZip) || encryptedZip.length === 0) {
            return res.status(400).json({ success: false, error: 'Šifrēts ZIP ir obligāts' });
        }
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'NFT nepieder šim makam' });
        }
        
        const turbo = getTurbo();
        
        const zipBuffer = Buffer.from(encryptedZip);
        logInfo('Šifrētā ZIP izmērs', zipBuffer.length + ' bytes');
        
        // 1. ZIP APMAKSA
        const fileCostWei = ethers.parseEther(fileCostEth);
        
        logSection('💳 ZIP APMAKSA');
        if (fileCostWei > 0n) {
            const turboAddress = await getTurboPaymentAddress();
            const operatorWallet = getOperatorWallet(provider);
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            
            const treasuryRead = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
            const isOp = await treasuryRead.isOperator(operatorWallet.address);
            if (!isOp) return res.status(500).json({ success: false, error: 'Operators nav atļauts' });
            
            const paymentId = ethers.id(repoName + '-zip-' + Date.now().toString());
            const payTx = await treasuryWrite.payTurbo(fileCostWei, paymentId, turboAddress);
            await payTx.wait();
            
            logSuccess('ZIP transakcija: ' + payTx.hash);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // 2. ZIP AUGŠUPIELĀDE
        const zipResult = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(zipBuffer),
            fileSizeFactory: () => zipBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Repo', value: repoName },
                    { name: 'Type', value: 'backup-archive' },
                    { name: 'Content-Type', value: 'application/zip' },
                    { name: 'Encrypted', value: 'true' },
                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                ]
            }
        });
        
        logSuccess(`ZIP TX ID: ${zipResult.id}`);
        
        // 3. KREDĪTI
        await setUserCredits(walletAddress, BigInt(newUserCredits || '0'));
        
        // 4. ATGRIEŽ ZIP TX ID — manifesta apmaksa būs atsevišķs posms
        res.json({
            success: true,
            step: 'zip_uploaded',
            zipTxId: zipResult.id,
            iv: iv || null
        });
    } catch (error) {
        logSection('❌ EXECUTE BACKUP ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// FINALIZE MANIFEST — 2. POSMS: Manifesta apmaksa + augšupielāde
// ==================================================

app.post('/api/finalize-manifest', async (req, res) => {
    try {
        const { 
            repoName, tokenId, walletAddress, manifestCostEth, zipTxId, 
            fileMetadata, unchangedFiles, previousHistory, previousManifestId, 
            previousBackupNumber, previousEncryptionIVs, iv
        } = req.body;
        
        logSection('📤 2. POSMS: MANIFESTS');
        logInfo('Repo', repoName);
        logInfo('Token ID', tokenId);
        logInfo('Manifesta izmaksas', manifestCostEth + ' ETH');
        
        if (!repoName) return res.status(400).json({ success: false, error: 'Nav repoName' });
        if (!walletAddress) return res.status(400).json({ success: false, error: 'Nav walletAddress' });
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId' });
        if (manifestCostEth === undefined) return res.status(400).json({ success: false, error: 'Nav manifestCostEth' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
            return res.status(403).json({ success: false, error: 'NFT nepieder šim makam' });
        }
        
        const turbo = getTurbo();
        
        // 1. MANIFESTA APMAKSA
        const manifestCostWei = ethers.parseEther(manifestCostEth);
        
        logSection('💳 MANIFESTA APMAKSA');
        if (manifestCostWei > 0n) {
            const turboAddress = await getTurboPaymentAddress();
            const operatorWallet = getOperatorWallet(provider);
            const treasuryWrite = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operatorWallet);
            
            const treasuryRead = new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, provider);
            const isOp = await treasuryRead.isOperator(operatorWallet.address);
            if (!isOp) return res.status(500).json({ success: false, error: 'Operators nav atļauts' });
            
            const paymentId = ethers.id(repoName + '-manifest-' + Date.now().toString());
            const payTx = await treasuryWrite.payTurbo(manifestCostWei, paymentId, turboAddress);
            await payTx.wait();
            
            logSuccess('Manifesta transakcija: ' + payTx.hash);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // 2. MANIFESTA IZVEIDE
        const backupCount = Number(await nftContract.getBackupCount(tokenId));
        const newBackupNumber = backupCount + 1;
        
        const history = [...(previousHistory || [])];
        if (previousManifestId) {
            history.push({
                backupNumber: previousBackupNumber || history.length,
                manifestId: previousManifestId,
                url: `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
            });
        }
        history.sort((a, b) => Number(b.backupNumber) - Number(a.backupNumber));
        
        const encryptionIVs = { ...(previousEncryptionIVs || {}) };
        if (iv && Array.isArray(iv)) {
            encryptionIVs[zipTxId] = iv;
        }
        
        const manifest = {
            metadata: {
                repo: repoName,
                backupNumber: newBackupNumber,
                timestamp: new Date().toISOString(),
                generatedBy: 'PermRepo v1.0.0'
            },
            manifest: 'arweave/paths',
            version: '0.2.0',
            encryption: { ivs: encryptionIVs },
            archive: {
                id: zipTxId,
                url: `${ARWEAVE_GATEWAY}/raw/${zipTxId}`,
                contains: fileMetadata || []
            },
            paths: {},
            history
        };
        
        for (const fileMeta of (fileMetadata || [])) {
            manifest.paths[fileMeta.path] = {
                zipId: zipTxId,
                hash: fileMeta.hash
            };
        }
        
        for (const [filePath, info] of Object.entries(unchangedFiles || {})) {
            if (info && info.zipId) {
                manifest.paths[filePath] = {
                    zipId: info.zipId,
                    hash: info.hash
                };
            }
        }
        
        const manifestPaths = Object.keys(manifest.paths);
        if (manifestPaths.length > 0) {
            manifest.index = { path: manifest.paths['README.md'] ? 'README.md' : manifestPaths[0] };
        }
        
        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
        logInfo('Manifesta izmērs', manifestBuffer.length + ' bytes');
        
        // 3. MANIFESTA AUGŠUPIELĀDE
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(manifestBuffer),
            fileSizeFactory: () => manifestBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Type', value: 'path-manifest' },
                    { name: 'Repo', value: repoName },
                    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                    { name: 'Unix-Time', value: String(Math.floor(Date.now() / 1000)) }
                ]
            }
        });
        
        logSuccess(`MANIFEST TX ID: ${manifestResult.id}`);
        
        res.json({
            success: true,
            manifestTxId: manifestResult.id,
            manifest,
            backupNumber: newBackupNumber
        });
    } catch (error) {
        logSection('❌ FINALIZE MANIFEST ERROR');
        logError(errorMessage(error));
        console.error(error);
        return res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

// ==================================================
// FINALIZE BACKUP — paraksts un Merkle sakne
// ==================================================

app.post('/api/finalize-backup', async (req, res) => {
    try {
        const { tokenId, manifestTxId, fileMetadata, deadline, signature } = req.body;
        
        if (!tokenId) return res.status(400).json({ success: false, error: 'Nav tokenId' });
        if (!manifestTxId) return res.status(400).json({ success: false, error: 'Nav manifestTxId' });
        if (!signature) return res.status(400).json({ success: false, error: 'Nav signature' });
        
        const provider = getProvider();
        const nftContract = new ethers.Contract(NFT_ADDRESS, NFT_ABI, provider);
        
        const merkleTxHash = await submitBackupWithMerkle({
            tokenId,
            manifestTxId,
            files: fileMetadata || [],
            deadline,
            signature,
            nftContract: new ethers.Contract(NFT_ADDRESS, NFT_ABI, getOperatorWallet(provider)),
            readContract: nftContract
        });
        
        logSuccess('Merkle sakne iesniegta!');
        logInfo('Transakcija', merkleTxHash);
        
        res.json({ success: true, merkleTxHash });
    } catch (error) {
        logError('Sign kļūda: ' + errorMessage(error));
        res.status(500).json({ success: false, error: errorMessage(error) });
    }
});

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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    logSection('🚀 PERMAREPO SERVERIS');
    logInfo('Ports', PORT);
    logInfo('TREASURY_ADDRESS', TREASURY_ADDRESS || '❌ NAV');
    logInfo('NFT_ADDRESS', NFT_ADDRESS || '❌ NAV');
    logInfo('SUBSCRIPTION_ADDRESS', SUBSCRIPTION_ADDRESS || '❌ NAV');
    logInfo('USDC_ADDRESS', USDC_ADDRESS || '❌ NAV');
    console.log('='.repeat(60) + '\n');
});
