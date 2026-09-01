// backup.js
const { ethers } = window;
let CONFIG = {};
let userAddress = null;
let signer = null;
let repoName = null;
let tokenId = null;
let githubUser = null;
let currentLanguage = localStorage.getItem('permrepo-language') || 'lv';
let currentJobId = null;
let currentFileCostEth = '0';
let currentManifestCostEth = '0';
let masterKey = null;
let currentUnchangedFiles = {};
let currentPreviousHistory = [];
let currentPreviousManifestId = null;
let currentPreviousBackupNumber = null;
let currentPreviousEncryptionIVs = {};
let currentFiles = [];
let currentFileMetadata = [];
let currentMerkleRoot = null;
let currentIV = null;
let hasDepositedFiles = false;
let hasDepositedManifest = false;

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
 'backup-title': 'PermRepo Backups', 'repo-label': 'Repozitorijs', 'nft-token': 'NFT Token ID',
 'backup-count': 'Backupu skaits', 'last-manifest': 'Pēdējais manifests', 'last-merkle': 'Pēdējā Merkle sakne',
 'start-backup': 'Sākt backupu', 'preparing': 'Sagatavo backupu...', 'no-changes': 'Nav izmaiņu — visi faili jau ir backupēti!',
 'generate-key': 'Ģenerē master atslēgu...', 'enter-key': 'Ievadi savu Master Key:',
 'deposit-files': 'Iemaksā Treasury par ZIP', 'deposit-manifest': 'Iemaksā Treasury par manifestu',
 'deposit-and-upload': 'Iemaksāt un augšupielādēt', 'uploading': 'Augšupielādē...', 'signing': 'Paraksti transakciju...',
 'backup-complete': 'Backups veiksmīgi pabeigts!', 'manifest-link': 'Manifests', 'file-cost': 'Failu izmaksas',
 'manifest-cost': 'Manifesta izmaksas', 'total-cost': 'Kopā', 'files-count': 'Faili', 'files-size': 'Failu izmērs',
 'manifest-size': 'Manifesta izmērs', 'creating-zip': 'Izveido ZIP...', 'encrypting': 'Šifrē ZIP...',
 'try-again': 'Mēģināt vēlreiz', 'transaction-cancelled': 'Transakcija atcelta', 'saving-key': 'Saglabāju — Turpināt',
 'copy-key': 'Kopēt', 'download-key': 'Lejupielādēt', 'key-title': 'Tava Master Atslēga',
 'key-description': 'Šī ir TAVA vienīgā atslēga visiem backupiem. Saglabā to password managerī vai citā drošā vietā!',
 'encrypted-required': 'Master Key ir obligāta!', 'waiting': 'Gaida apstiprinājumu...', 'success': 'Veiksmīgi!',
 'finish-btn': 'Pabeigt backupu', 'deposit-manifest-btn': 'Iemaksāt par manifestu un pabeigt',
 'zip-uploaded': 'ZIP augšupielādēts!', 'manifest-ready': 'Manifests gatavs'
 }
};

function t(key) { return translations.lv[key] || key; }

function formatFileSize(bytes) {
 if (bytes < 1024) return bytes + ' B';
 if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
 return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function init() {
 try {
 const configResponse = await fetch('/api/config');
 CONFIG = await configResponse.json();
 } catch { return; }
 
 const params = new URLSearchParams(window.location.search);
 repoName = params.get('repo');
 if (!repoName) return;
 
 const userResponse = await fetch('/api/github/user');
 const userData = await userResponse.json();
 if (!userData.success) { window.location.href = '/api/github/login'; return; }
 githubUser = userData.user;
 
 if (!window.ethereum) return;
 const provider = new ethers.BrowserProvider(window.ethereum);
 signer = await provider.getSigner();
 userAddress = await signer.getAddress();
 await loadNFTInfo();
}

async function loadNFTInfo() {
 try {
 const provider = new ethers.BrowserProvider(window.ethereum);
 const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
 const fullRepoName = `${githubUser}/${repoName}`;
 const repoHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName]));
 tokenId = await nftContract.repositoryTokens(repoHash);
 if (tokenId === 0n) return;
 
 document.getElementById('nftTokenId').textContent = tokenId.toString();
 document.getElementById('backupCount').textContent = (await nftContract.getBackupCount(tokenId)).toString();
 document.getElementById('lastManifest').textContent = (await nftContract.getManifestURI(tokenId)) || 'Nav';
 document.getElementById('lastMerkleRoot').textContent = (await nftContract.getLastMerkleRoot(tokenId)) || 'Nav';
 
 const button = document.getElementById('startBackupButton');
 button.style.display = 'block';
 button.disabled = false;
 button.textContent = t('start-backup');
 button.onclick = prepareBackup;
 } catch (e) {}
}

async function generateMasterKey() {
 return ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
}

function showMasterKey(keyToShow) {
 return new Promise((resolve) => {
 const modal = document.createElement('div');
 modal.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 1000;`;
 modal.innerHTML = `
 <div style="background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%;">
 <h2 style="color: #79c0ff; margin-bottom: 16px;">${t('key-title')}</h2>
 <p style="color: #b0b8c4; margin-bottom: 16px;">${t('key-description')}</p>
 <div style="background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; word-break: break-all; font-family: monospace; color: #e6edf3;">${keyToShow}</div>
 <button id="closeModalBtn" style="width: 100%; padding: 12px; background: #238636; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;">${t('saving-key')}</button>
 </div>`;
 document.body.appendChild(modal);
 document.getElementById('closeModalBtn').onclick = () => { modal.remove(); resolve(); };
 });
}

async function prepareBackup() {
 const button = document.getElementById('startBackupButton');
 button.disabled = true;
 setStatus(t('preparing'));
 
 try {
 const response = await fetch('/api/prepare-backup', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ repoName, walletAddress: userAddress })
 });
 const result = await response.json();
 if (!result.success) { button.disabled = false; button.textContent = t('start-backup'); return; }
 
 currentJobId = result.jobId;
 currentUnchangedFiles = result.unchangedFiles || {};
 currentFiles = result.files || [];
 currentFileCostEth = result.fileCostEth || '0';
 currentPreviousHistory = result.previousHistory || [];
 currentPreviousManifestId = result.previousManifestId || null;
 currentPreviousBackupNumber = result.previousBackupNumber || null;
 currentPreviousEncryptionIVs = result.previousEncryptionIVs || {};
 
 if (currentFiles.length === 0) { setStatus(t('no-changes')); button.disabled = false; button.textContent = t('start-backup'); return; }
 
 button.disabled = false;
 button.textContent = t('deposit-and-upload');
 button.onclick = executeZipUpload;
 } catch (e) {
 button.disabled = false;
 button.textContent = t('start-backup');
 }
}

async function executeZipUpload() {
 const button = document.getElementById('startBackupButton');
 button.disabled = true;
 try {
 const backupCount = Number(await document.getElementById('backupCount').textContent);
 if (backupCount === 0) {
 masterKey = await generateMasterKey();
 await showMasterKey(masterKey);
 } else {
 masterKey = prompt(t('enter-key'))?.trim();
 }
 if (!masterKey) { button.disabled = false; button.textContent = t('deposit-and-upload'); return; }
 
 setStatus(t('creating-zip'));
 const zip = new JSZip();
 for (const file of currentFiles) {
 zip.file(file.path, Uint8Array.from(atob(file.content), c => c.codePointAt(0)));
 }
 const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
 
 setStatus(t('encrypting'));
 const encrypted = await encryptData(zipBuffer, masterKey);
 currentIV = encrypted.iv;
 currentMerkleRoot = calculateMerkleRoot(currentFiles);
 currentFileMetadata = currentFiles.map(file => ({ path: file.path, hash: file.hash }));
 
 const fileCostWei = ethers.parseEther(currentFileCostEth);
 let filePaymentTxHash = null;
 
 if (fileCostWei > 0n && !hasDepositedFiles) {
 setStatus(`${t('deposit-files')}: ${currentFileCostEth} Base ETH...`);
 const tx = await signer.sendTransaction({ to: CONFIG.treasuryAddress, value: fileCostWei });
 setStatus(t('waiting'));
 await tx.wait();
 filePaymentTxHash = tx.hash;
 setStatus(t('success'));
 hasDepositedFiles = true;
 }
 
 setStatus(t('uploading'));
 const executeResponse = await fetch('/api/execute-backup', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 jobId: currentJobId,
 encryptedZip: Array.from(encrypted.encrypted),
 iv: Array.from(currentIV),
 fileMetadata: currentFileMetadata,
 paymentTxHash: filePaymentTxHash // Pievienots transakcijas hešs idempotencei
 })
 });
 
 const executeResult = await executeResponse.json();
 if (!executeResult.success) { button.disabled = false; button.textContent = t('try-again'); return; }
 
 button.disabled = false;
 button.textContent = t('deposit-manifest-btn');
 button.onclick = () => finalizeManifest(executeResult.zipTxId, button);
 } catch (e) {
 button.disabled = false;
 button.textContent = t('deposit-and-upload');
 }
}

async function finalizeManifest(zipTxId, button) {
 button.disabled = true;
 try {
 setStatus(t('uploading'));
 const manifestResponse = await fetch('/api/finalize-manifest', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 jobId: currentJobId, zipTxId, fileMetadata: currentFileMetadata,
 unchangedFiles: currentUnchangedFiles, iv: Array.from(currentIV)
 })
 });
 const manifestResult = await manifestResponse.json();
 if (!manifestResult.success) { button.disabled = false; button.textContent = t('try-again'); return; }
 
 currentManifestCostEth = manifestResult.manifestCostEth || '0';
 const manifestCostWei = ethers.parseEther(currentManifestCostEth);
 
 if (manifestCostWei > 0n && !hasDepositedManifest) {
 setStatus(`${t('deposit-manifest')}: ${currentManifestCostEth} Base ETH...`);
 const tx = await signer.sendTransaction({ to: CONFIG.treasuryAddress, value: manifestCostWei });
 setStatus(t('waiting'));
 await tx.wait();
 setStatus(t('success'));
 hasDepositedManifest = true;
 }
 
 setStatus(t('signing'));
 const provider = new ethers.BrowserProvider(window.ethereum);
 const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
 const deadline = Math.floor(Date.now() / 1000) + 600;
 const currentNonce = await readContract.getNonce(tokenId);
 const onChainBackupCount = await readContract.getBackupCount(tokenId);
 const manifestURI = `ar://${manifestResult.manifestTxId}`;
 const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
 
 const domain = { name: 'PermRepo', version: '1', chainId: Number.parseInt(CONFIG.chainId, 16), verifyingContract: CONFIG.nftAddress };
 const types = { AddBackup: [{ name: 'tokenId', type: 'uint256' }, { name: 'backupNumber', type: 'uint256' }, { name: 'manifestHash', type: 'bytes32' }, { name: 'merkleRoot', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] };
 const value = { tokenId: BigInt(tokenId), backupNumber: onChainBackupCount + 1n, manifestHash, merkleRoot: currentMerkleRoot, deadline: BigInt(deadline), nonce: currentNonce };
 
 const signature = await signer.signTypedData(domain, types, value);
 
 const finalizeResponse = await fetch('/api/finalize-backup', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ jobId: currentJobId, tokenId: tokenId.toString(), manifestTxId: manifestResult.manifestTxId, fileMetadata: currentFileMetadata, deadline, signature })
 });
 
 const finalizeResult = await finalizeResponse.json();
 if (finalizeResult.success) {
 button.style.display = 'none';
 setStatus(t('backup-complete'));
 } else {
 button.disabled = false;
 button.textContent = t('try-again');
 }
 } catch (e) {
 button.disabled = false;
 button.textContent = t('deposit-manifest-btn');
 }
}

async function encryptData(data, keyHex) {
 const keyBytes = ethers.getBytes(keyHex);
 const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
 return { encrypted: new Uint8Array(encrypted), iv };
}

function calculateMerkleRoot(files) {
 const fileHashes = files.map(file => ethers.keccak256(ethers.toUtf8Bytes(file.hash || '')));
 if (fileHashes.length === 0) return '0x0000000000000000000000000000000000000000000000000000000000000000';
 return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes]));
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
init();
