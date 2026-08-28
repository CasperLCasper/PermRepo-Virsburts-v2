// backup.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let repoName = null;
let tokenId = null;
let githubUser = null;
let currentLanguage = localStorage.getItem('permrepo-language') || 'lv';
let currentFileCostEth = '0';
let currentManifestCostEth = '0';
let currentNewUserCredits = '0';
let masterKey = null;
let currentUnchangedFiles = {};
let currentPreviousHistory = [];
let currentPreviousManifestId = null;
let currentPreviousBackupNumber = null;
let currentPreviousEncryptionIVs = {};
let currentFiles = [];
let hasDepositedFiles = false;

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

const translations = {
    lv: {
        'backup-title': '📦 PermRepo Backups',
        'repo-label': 'Repozitorijs',
        'nft-token': 'NFT Token ID',
        'backup-count': 'Backupu skaits',
        'last-manifest': 'Pēdējais manifests',
        'last-merkle': 'Pēdējā Merkle sakne',
        'start-backup': 'Sākt backupu',
        'preparing': 'Sagatavo backupu...',
        'no-changes': '✅ Nav izmaiņu — visi faili jau ir backupēti!',
        'generate-key': 'Ģenerē master atslēgu...',
        'enter-key': 'Ievadi savu Master Key:',
        'deposit-files': 'Iemaksā Treasury par ZIP',
        'deposit-and-upload': 'Iemaksāt un augšupielādēt',
        'uploading': 'Augšupielādē...',
        'signing': 'Paraksti transakciju...',
        'backup-complete': '✅ Backups veiksmīgi pabeigts!',
        'manifest-link': '📦 Manifests',
        'file-cost': '💳 Failu izmaksas',
        'manifest-cost': '📄 Manifesta izmaksas',
        'total-cost': '💎 Kopā',
        'files-count': '📦 Faili',
        'files-size': '📦 Failu izmērs',
        'creating-zip': 'Izveido ZIP...',
        'encrypting': 'Šifrē ZIP...',
        'try-again': 'Mēģināt vēlreiz',
        'transaction-cancelled': 'Transakcija atcelta',
        'saving-key': 'Saglabāju — Turpināt',
        'copy-key': '📋 Kopēt',
        'download-key': '⬇️ Lejupielādēt',
        'key-title': '🔑 Tava Master Atslēga',
        'key-description': 'Šī ir TAVA vienīgā atslēga visiem backupiem. Saglabā to password managerī vai citā drošā vietā!',
        'encrypted-required': 'Master Key ir obligāta!'
    },
    en: {
        'backup-title': '📦 PermRepo Backups',
        'repo-label': 'Repository',
        'nft-token': 'NFT Token ID',
        'backup-count': 'Backup count',
        'last-manifest': 'Last manifest',
        'last-merkle': 'Last Merkle root',
        'start-backup': 'Start backup',
        'preparing': 'Preparing backup...',
        'no-changes': '✅ No changes — all files already backed up!',
        'generate-key': 'Generating master key...',
        'enter-key': 'Enter your Master Key:',
        'deposit-files': 'Deposit to Treasury for ZIP',
        'deposit-and-upload': 'Deposit and upload',
        'uploading': 'Uploading...',
        'signing': 'Sign transaction...',
        'backup-complete': '✅ Backup successfully completed!',
        'manifest-link': '📦 Manifest',
        'file-cost': '💳 File cost',
        'manifest-cost': '📄 Manifest cost',
        'total-cost': '💎 Total',
        'files-count': '📦 Files',
        'files-size': '📦 File size',
        'creating-zip': 'Creating ZIP...',
        'encrypting': 'Encrypting ZIP...',
        'try-again': 'Try again',
        'transaction-cancelled': 'Transaction cancelled',
        'saving-key': 'I saved it — Continue',
        'copy-key': '📋 Copy',
        'download-key': '⬇️ Download',
        'key-title': '🔑 Your Master Key',
        'key-description': 'This is YOUR only key for all backups. Save it in a password manager or other safe place!',
        'encrypted-required': 'Master Key is required!'
    },
    eo: {
        'backup-title': '📦 PermRepo Sekurkopioj',
        'repo-label': 'Deponejo',
        'nft-token': 'NFT Ĵetono ID',
        'backup-count': 'Nombro de sekurkopioj',
        'last-manifest': 'Lasta manifesto',
        'last-merkle': 'Lasta Merkle-radiko',
        'start-backup': 'Komenci sekurkopion',
        'preparing': 'Preparante sekurkopion...',
        'no-changes': '✅ Neniu ŝanĝo — ĉiuj dosieroj jam sekurkopiitaj!',
        'generate-key': 'Generante ĉefŝlosilon...',
        'enter-key': 'Enigu vian Ĉefŝlosilon:',
        'deposit-files': 'Deponi al Treasury por ZIP',
        'deposit-and-upload': 'Deponi kaj alŝuti',
        'uploading': 'Alŝutante...',
        'signing': 'Subskribante transakcion...',
        'backup-complete': '✅ Sekurkopio sukcese finita!',
        'manifest-link': '📦 Manifesto',
        'file-cost': '💳 Dosierkosto',
        'manifest-cost': '📄 Manifestkosto',
        'total-cost': '💎 Sumo',
        'files-count': '📦 Dosieroj',
        'files-size': '📦 Dosiergrando',
        'creating-zip': 'Kreante ZIP...',
        'encrypting': 'Ĉifrante ZIP...',
        'try-again': 'Reprovi',
        'transaction-cancelled': 'Transakcio nuligita',
        'saving-key': 'Mi konservis ĝin — Daŭrigi',
        'copy-key': '📋 Kopii',
        'download-key': '⬇️ Elŝuti',
        'key-title': '🔑 Via Ĉefŝlosilo',
        'key-description': 'Ĉi tiu estas VIA sola ŝlosilo por ĉiuj sekurkopioj. Konservu ĝin en pasvort-administrilo aŭ alia sekura loko!',
        'encrypted-required': 'Ĉefŝlosilo estas deviga!'
    }
};

function t(key) {
    return translations[currentLanguage][key] || translations.lv[key] || key;
}

function switchLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('permrepo-language', lang);
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
    applyTranslations();
    if (repoName) {
        document.getElementById('repoTitle').textContent = `${t('repo-label')}: ${repoName}`;
    }
    if (tokenId) {
        loadNFTInfo();
    }
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
}

async function init() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
        btn.onclick = () => switchLanguage(btn.dataset.lang);
    });
    
    applyTranslations();
    
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
    
    document.getElementById('repoTitle').textContent = `${t('repo-label')}: ${repoName}`;
    
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (!userData.success) {
        window.location.href = '/api/github/login';
        return;
    }
    
    githubUser = userData.user;
    
    if (!window.ethereum) {
        showError('Lūdzu instalē maku!');
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
        
        const button = document.getElementById('startBackupButton');
        button.style.display = 'block';
        button.disabled = false;
        button.textContent = t('start-backup');
        button.onclick = prepareBackup;
        
    } catch (e) {
        showError(e.message);
    }
}

// ==================================================
// MASTER KEY — VIENKĀRŠA ĢENERĒŠANA
// ==================================================

async function generateMasterKey() {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    return ethers.hexlify(keyBytes);
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
                <h2 style="color: #79c0ff; margin-bottom: 16px;">${t('key-title')}</h2>
                <p style="color: #b0b8c4; margin-bottom: 16px;">${t('key-description')}</p>
                <div style="background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; word-break: break-all; font-family: monospace; color: #e6edf3;">
                    ${masterKey}
                </div>
                <button id="copyKeyBtn" style="width: 100%; padding: 12px; background: #238636; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-bottom: 8px;">${t('copy-key')}</button>
                <button id="downloadKeyBtn" style="width: 100%; padding: 12px; background: #21262d; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; margin-bottom: 8px;">${t('download-key')}</button>
                <button id="closeModalBtn" style="width: 100%; padding: 12px; background: #f85149; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;">${t('saving-key')}</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('copyKeyBtn').onclick = async () => {
            await navigator.clipboard.writeText(masterKey);
            document.getElementById('copyKeyBtn').textContent = '✅';
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
// PREPARE BACKUP
// ==================================================

async function prepareBackup() {
    const button = document.getElementById('startBackupButton');
    button.disabled = true;
    button.textContent = '⏳ ' + t('preparing');
    
    setStatus(t('preparing'));
    
    try {
        const response = await fetch('/api/prepare-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoName, walletAddress: userAddress })
        });
        
        const result = await response.json();
        
        if (!result.success) {
            showError(result.error || 'Kļūda');
            button.disabled = false;
            button.textContent = t('start-backup');
            return;
        }
        
        currentUnchangedFiles = result.unchangedFiles || {};
        currentFiles = result.files || [];
        currentFileCostEth = result.fileCostEth || '0';
        currentNewUserCredits = result.newUserCredits || '0';
        currentPreviousHistory = result.previousHistory || [];
        currentPreviousManifestId = result.previousManifestId || null;
        currentPreviousBackupNumber = result.previousBackupNumber || null;
        currentPreviousEncryptionIVs = result.previousEncryptionIVs || {};
        
        if (currentFiles.length === 0) {
            setStatus(t('no-changes'));
            button.disabled = false;
            button.textContent = t('start-backup');
            return;
        }
        
        const totalBytes = result.totalBytes || 0;
        
        document.getElementById('status').innerHTML = 
            `${t('files-count')}: ${currentFiles.length}<br>` +
            `${t('files-size')}: ${(totalBytes / 1024 / 1024).toFixed(2)} MB<br>` +
            `${t('file-cost')}: ${currentFileCostEth} ETH`;
        
        button.disabled = false;
        button.textContent = t('deposit-and-upload');
        button.onclick = executeBackup;
        
    } catch (e) {
        showError(e.message);
        button.disabled = false;
        button.textContent = t('start-backup');
    }
}

// ==================================================
// EXECUTE BACKUP — MK OBLIGĀTA, PLAINTEXT NETIEK SŪTĪTS
// ==================================================

async function executeBackup() {
    const button = document.getElementById('startBackupButton');
    button.disabled = true;
    
    try {
        // 1. MASTER KEY
        const backupCount = await getBackupCountFromChain();
        
        if (backupCount === 0) {
            setStatus(t('generate-key'));
            button.textContent = '⏳';
            
            masterKey = await generateMasterKey();
            await showMasterKey(masterKey);
        } else {
            masterKey = prompt(t('enter-key'));
            if (masterKey) {
                masterKey = masterKey.trim();
            }
        }
        
        // MK OBLIGĀTA
        if (!masterKey || !masterKey.trim()) {
            showError(t('encrypted-required'));
            button.disabled = false;
            button.textContent = t('deposit-and-upload');
            return;
        }
        
        // 2. ZIP IZVEIDE PĀRLŪKĀ
        setStatus(t('creating-zip'));
        
        const zip = new JSZip();
        for (const file of currentFiles) {
            const fileBuffer = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
            zip.file(file.path, fileBuffer);
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
        
        // 3. ŠIFRĒ PĀRLŪKĀ
        setStatus(t('encrypting'));
        
        const encrypted = await encryptData(zipBuffer, masterKey);
        const encryptedZipData = encrypted.encrypted;
        const iv = encrypted.iv;
        
        // 4. Merkle sakne — pārlūkā
        const merkleRoot = calculateMerkleRoot(currentFiles);
        
        // 5. Metadata priekš servera — BEZ failu satura
        const fileMetadata = currentFiles.map(file => ({
            path: file.path,
            hash: file.hash
        }));
        
        // 6. IEMAKSA PAR ZIP
        const fileCostWei = ethers.parseEther(currentFileCostEth);
        
        if (fileCostWei > 0n && !hasDepositedFiles) {
            setStatus(`${t('deposit-files')}: ${currentFileCostEth} ETH...`);
            button.textContent = '⏳';
            
            const tx = await signer.sendTransaction({
                to: CONFIG.treasuryAddress,
                value: fileCostWei
            });
            
            await tx.wait();
            hasDepositedFiles = true;
        }
        
        // 7. AUGŠUPIELĀDE — TIKAI šifrētais ZIP + metadata
        setStatus(t('uploading'));
        
        const executeResponse = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName: `${githubUser}/${repoName}`,
                tokenId: tokenId.toString(),
                walletAddress: userAddress,
                fileCostEth: currentFileCostEth,
                newUserCredits: currentNewUserCredits,
                encryptedZip: Array.from(encryptedZipData),
                iv: Array.from(iv),
                fileMetadata,
                unchangedFiles: currentUnchangedFiles,
                merkleRoot,
                previousHistory: currentPreviousHistory,
                previousManifestId: currentPreviousManifestId,
                previousBackupNumber: currentPreviousBackupNumber,
                previousEncryptionIVs: currentPreviousEncryptionIVs
            })
        });
        
        const executeResult = await executeResponse.json();
        
        if (!executeResult.success) {
            showError(executeResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = t('try-again');
            return;
        }
        
        // 8. PARAKSTS
        setStatus(t('signing'));
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const currentNonce = await readContract.getNonce(tokenId);
        const onChainBackupCount = await readContract.getBackupCount(tokenId);
        
        const manifestURI = `ar://${executeResult.manifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        
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
        
        // 9. FINALIZE — TIKAI metadata, bez failu satura
        const finalizeResponse = await fetch('/api/finalize-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tokenId: tokenId.toString(),
                manifestTxId: executeResult.manifestTxId,
                fileMetadata,
                deadline,
                signature
            })
        });
        
        const finalizeResult = await finalizeResponse.json();
        
        if (finalizeResult.success) {
            // NOTĪRA MK NO ATMIŅAS
            masterKey = null;
            
            button.style.display = 'none';
            
            document.getElementById('status').innerHTML = 
                `${t('backup-complete')}<br><br>` +
                `${t('manifest-link')}: <a href="${CONFIG.arweaveGateway}/raw/${executeResult.manifestTxId}" target="_blank">ar://${executeResult.manifestTxId}</a><br>` +
                `${t('file-cost')}: ${currentFileCostEth} ETH`;
        } else {
            showError(finalizeResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = t('try-again');
        }
        
    } catch (e) {
        masterKey = null;
        
        if (e.code === 'ACTION_REJECTED') {
            showError(t('transaction-cancelled'));
        } else {
            showError(e.message);
        }
        button.disabled = false;
        button.textContent = t('deposit-and-upload');
    }
}

async function getBackupCountFromChain() {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
    const count = await nftContract.getBackupCount(tokenId);
    return Number(count);
}

// ==================================================
// ŠIFRĒŠANA — vienkāršota, ar ethers.getBytes
// ==================================================

async function encryptData(data, keyHex) {
    const keyBytes = ethers.getBytes(keyHex);
    
    if (keyBytes.length !== 32) {
        throw new Error('Invalid Master Key');
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
