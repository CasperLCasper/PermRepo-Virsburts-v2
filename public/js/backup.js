// backup.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let repoName = null;
let tokenId = null;
let githubUser = null;
let currentFileCostEth = '0';
let currentManifestCostEth = '0';
let currentNewUserCredits = '0';
let currentNewManifestCredits = '0';
let currentFileWinc = '0';
let currentUserCredits = '0';
let currentZipSize = 0;
let currentFileCount = 0;
let masterKey = null;
let currentUnchangedFiles = {};
let currentPreviousHistory = [];
let currentPreviousManifestId = null;
let currentPreviousBackupNumber = null;

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

async function init() {
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        showError('Neizdevās iegūt konfigurāciju');
        return;
    }
    
    const params = new URLSearchParams(window.location.search);
    repoName = params.get('repo');
    
    if (!repoName) {
        showError('Nav repo nosaukuma URL parametrā!');
        return;
    }
    
    document.getElementById('repoTitle').textContent = 'Repozitorijs: ' + repoName;
    
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (!userData.success) {
        window.location.href = '/api/github/login';
        return;
    }
    
    githubUser = userData.user;
    
    if (!window.ethereum) {
        showError('Lūdzu instalē MetaMask!');
        return;
    }
    
    try {
        await window.ethereum.request({ 
            method: 'wallet_switchEthereumChain', 
            params: [{ chainId: CONFIG.chainId }] 
        });
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        userAddress = await signer.getAddress();
        
        await loadNFTInfo();
    } catch (e) {
        showError(e.message);
    }
}

async function loadNFTInfo() {
    try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        const fullRepoName = `${githubUser}/${repoName}`;
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName])
        );
        
        tokenId = await nftContract.repositoryTokens(repoHash);
        
        if (tokenId === 0n) {
            showError('Nav NFT šim repo!');
            return;
        }
        
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== userAddress.toLowerCase()) {
            showError('NFT nepieder šim makam!');
            return;
        }
        
        document.getElementById('nftTokenId').textContent = tokenId.toString();
        
        const backupCount = await nftContract.getBackupCount(tokenId);
        document.getElementById('backupCount').textContent = backupCount.toString();
        
        const lastManifest = await nftContract.getManifestURI(tokenId);
        document.getElementById('lastManifest').textContent = lastManifest || 'Nav';
        
        const lastMerkleRoot = await nftContract.getLastMerkleRoot(tokenId);
        document.getElementById('lastMerkleRoot').textContent = lastMerkleRoot || 'Nav';
        
        document.getElementById('startBackupButton').disabled = false;
        document.getElementById('startBackupButton').onclick = startBackup;
        
    } catch (e) {
        showError(e.message);
    }
}

// ==================================================
// MASTER KEY ĢENERĒŠANA
// ==================================================

async function generateMasterKey(walletAddress, repoName, tokenId, githubUser) {
    const cryptoRandom = new Uint8Array(64);
    crypto.getRandomValues(cryptoRandom);
    
    const ethersRandom = ethers.randomBytes(64);
    
    const message = [
        'PermRepo Master Key',
        `GitHub: ${githubUser}`,
        `Repo: ${repoName}`,
        `Token: ${tokenId}`,
        `Wallet: ${walletAddress}`,
        `Time: ${Date.now()}`,
        `Nonce: ${Math.random().toString(36)}`
    ].join('\n');
    
    const signature = await signer.signMessage(message);
    
    const allEntropy = ethers.concat([
        cryptoRandom,
        ethersRandom,
        ethers.getBytes(signature),
        ethers.toUtf8Bytes(walletAddress),
        ethers.toUtf8Bytes(githubUser),
        ethers.toUtf8Bytes(repoName),
        ethers.toUtf8Bytes(tokenId.toString())
    ]);
    
    let masterKey = ethers.keccak256(allEntropy);
    
    for (let i = 0; i < 1000; i++) {
        masterKey = ethers.keccak256(
            ethers.concat([
                masterKey,
                ethers.toUtf8Bytes(i.toString())
            ])
        );
    }
    
    return masterKey;
}

function showMasterKey(masterKey) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.8);
            display: flex; justify-content: center; align-items: center;
            z-index: 1000;
        `;
        
        modal.innerHTML = `
            <div style="background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%;">
                <h2 style="color: #79c0ff; margin-bottom: 16px;">🔑 Tava Master Atslēga</h2>
                <p style="color: #b0b8c4; margin-bottom: 16px;">Šī ir TAVA vienīgā atslēga visiem backupiem. Saglabā to drošā vietā!</p>
                <div style="background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; word-break: break-all; font-family: monospace; color: #e6edf3;">
                    ${masterKey}
                </div>
                <button id="copyKeyBtn" style="width: 100%; padding: 12px; background: #238636; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-bottom: 8px;">📋 Kopēt</button>
                <button id="downloadKeyBtn" style="width: 100%; padding: 12px; background: #21262d; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-bottom: 8px;">⬇️ Lejupielādēt</button>
                <button id="closeModalBtn" style="width: 100%; padding: 12px; background: #f85149; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;">Es saglabāju — Turpināt</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('copyKeyBtn').onclick = async () => {
            await navigator.clipboard.writeText(masterKey);
            document.getElementById('copyKeyBtn').textContent = '✅ Nokopēts!';
        };
        
        document.getElementById('downloadKeyBtn').onclick = () => {
            const blob = new Blob([masterKey], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `permrepo-master-key-${repoName.replace('/', '-')}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        };
        
        document.getElementById('closeModalBtn').onclick = () => {
            modal.remove();
            resolve();
        };
    });
}

// ==================================================
// BACKUP PROCESS
// ==================================================

async function startBackup() {
    const button = document.getElementById('startBackupButton');
    button.disabled = true;
    button.textContent = '⏳ Sagatavo...';
    
    setStatus('Sagatavo backupu...');
    
    try {
        // 1. PREPARE BACKUP
        const prepareResponse = await fetch('/api/prepare-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                repoName, 
                walletAddress: userAddress 
            })
        });
        
        const prepareResult = await prepareResponse.json();
        
        if (!prepareResult.success) {
            showError(prepareResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        const files = prepareResult.files || [];
        
        if (files.length === 0) {
            setStatus('✅ Nav izmaiņu — visi faili jau ir backupēti!');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        currentFileCostEth = prepareResult.fileCostEth || '0';
        currentNewUserCredits = prepareResult.newUserCredits || '0';
        currentFileWinc = prepareResult.fileWinc || '0';
        currentUserCredits = prepareResult.userCredits || '0';
        currentZipSize = prepareResult.estimatedZipSize || 0;
        currentFileCount = files.length;
        currentUnchangedFiles = prepareResult.unchangedFiles || {};
        currentPreviousHistory = prepareResult.previousHistory || [];
        currentPreviousManifestId = prepareResult.previousManifestId || null;
        currentPreviousBackupNumber = prepareResult.previousBackupNumber || null;
        
        // 2. MASTER KEY
        const currentBackupCount = Number(prepareResult.backupCount || 0);
        
        if (currentBackupCount === 0) {
            setStatus('Ģenerē master atslēgu...');
            button.textContent = '⏳ Atslēga...';
            
            const fullRepoName = `${githubUser}/${repoName}`;
            masterKey = await generateMasterKey(userAddress, fullRepoName, tokenId, githubUser);
            await showMasterKey(masterKey);
        } else {
            masterKey = prompt('Ievadi savu master atslēgu (atstāj tukšu publiskam repo):');
            if (masterKey) {
                masterKey = masterKey.trim();
            }
        }
        
        // 3. PARĀDA INFORMĀCIJU
        currentManifestCostEth = prepareResult.fileCostEth;
        
        showBackupInfo(prepareResult, files);
        
        // 4. IEMAKSA
        const totalCostWei = ethers.parseEther(currentFileCostEth) + ethers.parseEther(currentManifestCostEth);
        const totalCostEth = ethers.formatEther(totalCostWei);
        
        if (totalCostWei > 0n) {
            setStatus(`Iemaksā Treasury: ${totalCostEth} ETH...`);
            button.textContent = '⏳ Iemaksa...';
            
            const tx = await signer.sendTransaction({
                to: CONFIG.treasuryAddress,
                value: totalCostWei
            });
            
            setStatus('Gaida iemaksas apstiprinājumu...');
            button.textContent = '⏳ Gaida...';
            await tx.wait();
            
            setStatus('✅ Iemaksa veiksmīga!');
        }
        
        // 5. ZIP IZVEIDE
        setStatus('Izveido ZIP...');
        button.textContent = '⏳ ZIP...';
        
        const zip = new JSZip();
        for (const file of files) {
            const fileBuffer = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
            zip.file(file.path, fileBuffer);
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
        
        // 6. ŠIFRĒ
        let encryptedZipData = zipBuffer;
        let iv = null;
        
        if (masterKey && masterKey.trim()) {
            setStatus('Šifrē ZIP ar master atslēgu...');
            button.textContent = '⏳ Šifrē...';
            
            const encrypted = await encryptData(zipBuffer, masterKey);
            encryptedZipData = encrypted.encrypted;
            iv = encrypted.iv;
        }
        
        // 7. AUGŠUPIELĀDE
        setStatus('Augšupielādē...');
        button.textContent = '⏳ Augšupielāde...';
        
        const executeResponse = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName: `${githubUser}/${repoName}`,
                files,
                unchangedFiles: currentUnchangedFiles,
                tokenId: tokenId.toString(),
                walletAddress: userAddress,
                fileCostEth: currentFileCostEth,
                manifestCostEth: currentManifestCostEth,
                newUserCredits: currentNewUserCredits,
                encryptedZip: Array.from(encryptedZipData),
                iv: iv ? Array.from(iv) : null,
                previousHistory: currentPreviousHistory,
                previousManifestId: currentPreviousManifestId,
                previousBackupNumber: currentPreviousBackupNumber
            })
        });
        
        const executeResult = await executeResponse.json();
        
        if (!executeResult.success) {
            showError(executeResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        // 8. PARAKSTS
        setStatus('Manifests augšupielādēts! Paraksti transakciju...');
        button.textContent = '⏳ Paraksts...';
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const currentNonce = await readContract.getNonce(tokenId);
        const onChainBackupCount = await readContract.getBackupCount(tokenId);
        
        const manifestURI = `ar://${executeResult.manifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        const merkleRoot = calculateMerkleRoot(files);
        
        const domain = {
            name: 'PermRepo',
            version: '1',
            chainId: parseInt(CONFIG.chainId, 16),
            verifyingContract: CONFIG.nftAddress
        };
        
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
        
        const value = {
            tokenId: BigInt(tokenId),
            backupNumber: onChainBackupCount + 1n,
            manifestHash,
            merkleRoot,
            deadline: BigInt(deadline),
            nonce: currentNonce
        };
        
        const signature = await signer.signTypedData(domain, types, value);
        
        const finalizeResponse = await fetch('/api/finalize-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tokenId: tokenId.toString(),
                manifestTxId: executeResult.manifestTxId,
                files,
                deadline,
                signature
            })
        });
        
        const finalizeResult = await finalizeResponse.json();
        
        if (finalizeResult.success) {
            document.getElementById('status').innerHTML = `
                ✅ Backups veiksmīgi pabeigts!<br><br>
                📦 Manifests: <a href="${CONFIG.arweaveGateway}/raw/${executeResult.manifestTxId}" target="_blank">ar://${executeResult.manifestTxId}</a><br>
                💳 Failu izmaksas: ${currentFileCostEth} ETH<br>
                📄 Manifesta izmaksas: ${currentManifestCostEth} ETH<br>
                💎 Kopā: ${totalCostEth} ETH
            `;
            button.textContent = '✅ Pabeigts!';
            await loadNFTInfo();
        } else {
            showError(finalizeResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
        }
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = 'Sākt backupu';
    }
}

function showBackupInfo(prepareResult, files) {
    const totalCostEth = ethers.formatEther(
        ethers.parseEther(prepareResult.fileCostEth) + ethers.parseEther(prepareResult.fileCostEth)
    );
    
    const infoHtml = `
        <div style="margin: 16px 0; padding: 16px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px;">
            <h3 style="color: #79c0ff; margin-bottom: 12px;">📊 Backupa informācija</h3>
            <div style="color: #b0b8c4; font-size: 14px; line-height: 1.8;">
                <div>📦 Mainītie faili: <strong style="color: #e6edf3;">${files.length}</strong></div>
                <div>📁 Nemainītie faili: <strong style="color: #e6edf3;">${Object.keys(prepareResult.unchangedFiles || {}).length}</strong></div>
                <div>📦 ZIP izmērs (aptuveni): <strong style="color: #e6edf3;">${(prepareResult.estimatedZipSize / 1024 / 1024).toFixed(2)} MB</strong></div>
                <div>💰 Failu izmaksas: <strong style="color: #e6edf3;">${prepareResult.fileCostEth} ETH</strong></div>
                <div>📄 Manifesta izmaksas: <strong style="color: #e6edf3;">${prepareResult.fileCostEth} ETH</strong></div>
                <div>👛 Tavi kredīti: <strong style="color: #e6edf3;">${prepareResult.userCredits} winc</strong></div>
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #30363d;">
                    💎 <strong style="color: #3fb950; font-size: 16px;">KOPĀ JĀMAKSĀ: ${totalCostEth} ETH</strong>
                </div>
            </div>
        </div>
    `;
    
    document.getElementById('status').innerHTML = infoHtml;
}

// ==================================================
// PALĪGFUNKCIJAS
// ==================================================

async function encryptData(data, keyHex) {
    const key = keyHex.slice(2);
    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        keyBytes[i] = parseInt(key.substring(i * 2, i * 2 + 2), 16);
    }
    
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBytes, 'AES-GCM', false, ['encrypt']
    );
    
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        data
    );
    
    return { encrypted: new Uint8Array(encrypted), iv };
}

function calculateMerkleRoot(files) {
    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash || ''))
    );
    
    if (fileHashes.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }
    
    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );
    
    return combinedHash;
}

function setStatus(msg) { 
    document.getElementById('status').textContent = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

init();
