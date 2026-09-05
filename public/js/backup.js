/* global JSZip */

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

let currentZipTxId = null;

let hasDepositedFiles = false;
let hasDepositedManifest = false;

let currentManifestPayload = null;

// STATUS DATU SAGLABĀŠANA VALODAS MAIŅAI
let lastStatusData = null;
let backupCompleted = false;
let lastManifestTxId = null;

// POGAS STĀVOKĻA SAGLABĀŠANA
let buttonState = null; // { textKey: 'deposit-manifest-btn'|'deposit-and-upload'|'start-backup', disabled: true/false, onClick: 'manifest'|'zip'|'prepare' }

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getLastMerkleRoot(uint256 tokenId) external view returns (bytes32)",
    "function getNonce(uint256 tokenId) external view returns (uint256)",
    "function addBackup(uint256 tokenId, bytes32 manifestHash, bytes32 merkleRoot, string calldata manifestURI, uint256 deadline, bytes calldata signature) external"
];

// SVG IKONA
function icon(name) {
    return `<img src="icons/${name}.svg" class="icon-inline">`;
}

// DROŠA FUNKCIJA: Apstrādā tekstu ar mūsu ikonām bez XSS riska
function safeRender(container, message) {
    container.innerHTML = '';
    
    if (typeof message === 'string') {
        // Sadala pēc mūsu ikonām
        const parts = message.split(/(<img[^>]*>)/g);
        
        for (const part of parts) {
            if (part.startsWith('<img')) {
                // Pārbauda, vai šī ir MŪSU ģenerētā ikona
                if (part.includes('icons/') && part.includes('class="icon-inline"')) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = part;
                    if (tempDiv.firstChild) {
                        container.appendChild(tempDiv.firstChild);
                    }
                }
                // Ja nav mūsu ikona - ignorē (neizpilda)
            } else if (part.trim()) {
                // Vienkāršs teksts - droši ar textContent
                container.appendChild(document.createTextNode(part));
            }
        }
    }
}

const translations = {
    lv: {
        'backup-title': 'PermRepo Backups',
        'repo-label': 'Repozitorijs',
        'nft-token': 'NFT Token ID',
        'backup-count': 'Backupu skaits',
        'last-manifest': 'Pēdējais manifests',
        'last-merkle': 'Pēdējā Merkle sakne',
        'start-backup': 'Sākt backupu',
        'preparing': 'Sagatavo backupu...',
        'no-changes': 'Nav izmaiņu — visi faili jau ir backupēti!',
        'generate-key': 'Ģenerē master atslēgu...',
        'enter-key': 'Ievadi savu Master Key:',
        'deposit-files': 'Iemaksā Treasury par ZIP',
        'deposit-manifest': 'Iemaksā Treasury par manifestu',
        'deposit-and-upload': 'Iemaksāt un augšupielādēt',
        'uploading': 'Augšupielādē...',
        'signing': 'Paraksti transakciju...',
        'backup-complete': 'Backups veiksmīgi pabeigts!',
        'manifest-link': 'Manifests',
        'file-cost': 'Failu izmaksas',
        'manifest-cost': 'Manifesta izmaksas',
        'total-cost': 'Kopējās izmaksas',
        'files-count': 'Failu skaits',
        'files-size': 'Failu izmērs',
        'manifest-size': 'Manifesta izmērs',
        'creating-zip': 'Izveido ZIP...',
        'encrypting': 'Šifrē ZIP...',
        'try-again': 'Mēģināt vēlreiz',
        'transaction-cancelled': 'Transakcija atcelta',
        'saving-key': 'Saglabāju — Turpināt',
        'copy-key': 'Kopēt',
        'download-key': 'Lejupielādēt',
        'key-title': 'Tava Master Atslēga',
        'key-description': 'Šī ir TAVA vienīgā atslēga visiem backupiem. Saglabā to password managerī vai citā drošā vietā!',
        'encrypted-required': 'Master Key ir obligāta!',
        'waiting': 'Gaida apstiprinājumu...',
        'success': 'Veiksmīgi!',
        'finish-btn': 'Pabeigt backupu',
        'deposit-manifest-btn': 'Iemaksāt par manifestu un pabeigt',
        'zip-uploaded': 'ZIP augšupielādēts!',
        'manifest-ready': 'Manifests gatavs',
        'confirm-key': 'Apstiprināt',
        'cancel': 'Atcelt',
        'costs': 'Izmaksas',
        'back-home': 'Atgriezties uz sākumu'
    },
    en: {
        'backup-title': 'PermRepo Backups',
        'repo-label': 'Repository',
        'nft-token': 'NFT Token ID',
        'backup-count': 'Backup count',
        'last-manifest': 'Last manifest',
        'last-merkle': 'Last Merkle root',
        'start-backup': 'Start backup',
        'preparing': 'Preparing backup...',
        'no-changes': 'No changes — all files already backed up!',
        'generate-key': 'Generating master key...',
        'enter-key': 'Enter your Master Key:',
        'deposit-files': 'Deposit to Treasury for ZIP',
        'deposit-manifest': 'Deposit to Treasury for manifest',
        'deposit-and-upload': 'Deposit and upload',
        'uploading': 'Uploading...',
        'signing': 'Sign transaction...',
        'backup-complete': 'Backup successfully completed!',
        'manifest-link': 'Manifest',
        'file-cost': 'File cost',
        'manifest-cost': 'Manifest cost',
        'total-cost': 'Total cost',
        'files-count': 'File count',
        'files-size': 'File size',
        'manifest-size': 'Manifest size',
        'creating-zip': 'Creating ZIP...',
        'encrypting': 'Encrypting ZIP...',
        'try-again': 'Try again',
        'transaction-cancelled': 'Transaction cancelled',
        'saving-key': 'I saved it — Continue',
        'copy-key': 'Copy',
        'download-key': 'Download',
        'key-title': 'Your Master Key',
        'key-description': 'This is YOUR only key for all backups. Save it in a password manager or other safe place!',
        'encrypted-required': 'Master Key is required!',
        'waiting': 'Waiting for confirmation...',
        'success': 'Success!',
        'finish-btn': 'Finish backup',
        'deposit-manifest-btn': 'Deposit for manifest and finish',
        'zip-uploaded': 'ZIP uploaded!',
        'manifest-ready': 'Manifest ready',
        'confirm-key': 'Confirm',
        'cancel': 'Cancel',
        'costs': 'Cost',
        'back-home': 'Back to home'
    },
    eo: {
        'backup-title': 'PermRepo Sekurkopioj',
        'repo-label': 'Deponejo',
        'nft-token': 'NFT Ĵetono ID',
        'backup-count': 'Nombro de sekurkopioj',
        'last-manifest': 'Lasta manifesto',
        'last-merkle': 'Lasta Merkle-radiko',
        'start-backup': 'Komenci sekurkopion',
        'preparing': 'Preparante sekurkopion...',
        'no-changes': 'Neniu ŝanĝo — ĉiuj dosieroj jam sekurkopiitaj!',
        'generate-key': 'Generante ĉefŝlosilon...',
        'enter-key': 'Enigu vian Ĉefŝlosilon:',
        'deposit-files': 'Deponi al Treasury por ZIP',
        'deposit-manifest': 'Deponi al Treasury por manifesto',
        'deposit-and-upload': 'Deponi kaj alŝuti',
        'uploading': 'Alŝutante...',
        'signing': 'Subskribante transakcion...',
        'backup-complete': 'Sekurkopio sukcese finita!',
        'manifest-link': 'Manifesto',
        'file-cost': 'Dosierkosto',
        'manifest-cost': 'Manifestkosto',
        'total-cost': 'Suma kosto',
        'files-count': 'Dosiernombro',
        'files-size': 'Dosiergrando',
        'manifest-size': 'Manifestogrando',
        'creating-zip': 'Kreante ZIP...',
        'encrypting': 'Ĉifrante ZIP...',
        'try-again': 'Reprovi',
        'transaction-cancelled': 'Transakcio nuligita',
        'saving-key': 'Mi konservis ĝin — Daŭrigi',
        'copy-key': 'Kopii',
        'download-key': 'Elŝuti',
        'key-title': 'Via Ĉefŝlosilo',
        'key-description': 'Ĉi tiu estas VIA sola ŝlosilo por ĉiuj sekurkopioj. Konservu ĝin en pasvort-administrilo aŭ alia sekura loko!',
        'encrypted-required': 'Ĉefŝlosilo estas deviga!',
        'waiting': 'Atendante konfirmon...',
        'success': 'Sukceso!',
        'finish-btn': 'Fini sekurkopion',
        'deposit-manifest-btn': 'Deponi por manifesto kaj fini',
        'zip-uploaded': 'ZIP alŝutita!',
        'manifest-ready': 'Manifesto preta',
        'confirm-key': 'Konfirmi',
        'cancel': 'Nuligi',
        'costs': 'Kosto',
        'back-home': 'Reen al hejmo'
    }
};

function t(key) {
    return translations[currentLanguage]?.[key] || translations.lv[key] || key;
}

function switchLanguage(lang) {
    if (!translations[lang]) return;
    currentLanguage = lang;
    localStorage.setItem('permrepo-language', lang);
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
    applyTranslations();
    
    if (repoName) {
        const title = document.getElementById('repoTitle');
        if (title) title.textContent = `${t('repo-label')}: ${repoName}`;
    }
    
    // Atjaunot pogas tekstu atbilstoši saglabātajam stāvoklim
    restoreButtonState();
    
    // Atjaunot statusu ar pareizo valodu
    renderStatusFromData();
    
    // NEIZSAUKT loadNFTInfo(), jo tas atjauno pogu uz "Sākt backupu"
    // un pārtrauc aktīvu backup procesu
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
}

function formatFileSize(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isValidMasterKey(value) {
    try {
        if (typeof value !== 'string') return false;
        const normalized = value.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) return false;
        return ethers.getBytes(normalized).length === 32;
    } catch { return false; }
}

function normalizeWallet(address) {
    return ethers.getAddress(address);
}

function isUserRejected(error) {
    return error?.code === 4001 || error?.code === 'ACTION_REJECTED' || error?.info?.error?.code === 4001;
}

async function apiJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Servera kļūda: HTTP ${response.status}`); }
    if (!response.ok && !result.success && !result.paymentRequired) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}

// ==================================================
// POGAS STĀVOKĻA PĀRVALDĪBA
// ==================================================

function saveButtonState(textKey, disabled, onClickType) {
    buttonState = { textKey, disabled, onClickType };
}

function restoreButtonState() {
    const button = document.getElementById('startBackupButton');
    if (!button) return;
    
    if (backupCompleted) {
        button.style.display = 'block';
        button.disabled = false;
        button.textContent = t('back-home');
        button.onclick = () => { window.location.href = '/'; };
        return;
    }
    
    if (!buttonState) return;
    
    button.style.display = 'block';
    button.disabled = buttonState.disabled;
    button.textContent = t(buttonState.textKey);
    
    if (buttonState.disabled) return;
    
    switch(buttonState.onClickType) {
        case 'manifest':
            button.onclick = () => finalizeManifest(currentZipTxId, button);
            break;
        case 'zip':
            button.onclick = executeZipUpload;
            break;
        case 'prepare':
            button.onclick = prepareBackup;
            break;
    }
}

// ==================================================
// STATUS RENDERĒŠANA NO DATIEM
// ==================================================

function renderStatusFromData() {
    if (backupCompleted) {
        renderCompletedStatus();
        return;
    }
    
    if (!lastStatusData) return;
    
    const data = lastStatusData;
    
    switch(data.type) {
        case 'files':
            setStatus(
                `${icon('fails')} ${t('files-count')}: ${data.fileCount}\n` +
                `${icon('fails')} ${t('files-size')}: ${data.fileSizeText}`,
                'progress'
            );
            break;
        case 'cost':
            setStatus(
                `${icon('failu-izmaksas')} ${t('costs')}: ${data.cost} Base ETH`,
                'progress'
            );
            break;
        case 'uploading':
            setStatus(`${icon('upload')} ${t('uploading')}`, 'progress');
            break;
        case 'success':
            setStatus(`${icon('izdevas-veiksmigi')} ${t(data.key)}`, 'success');
            break;
        case 'manifest-ready':
            setStatus(
                `${icon('manifests')} ${t('manifest-ready')}\n\n` +
                `${t('manifest-size')}: ${data.manifestSizeText}\n` +
                `${icon('failu-izmaksas')} ${t('costs')}: ${data.cost} Base ETH`,
                'progress'
            );
            break;
        case 'signing':
            setStatus(t('signing'), 'progress');
            break;
        case 'waiting':
            setStatus(t('waiting'), 'progress');
            break;
        case 'simple':
            setStatus(t(data.key), data.statusType);
            break;
        default:
            setStatus(t(data.key), data.statusType);
    }
}

function renderCompletedStatus() {
    const totalCostEth = (Number.parseFloat(currentFileCostEth || '0') + Number.parseFloat(currentManifestCostEth || '0')).toFixed(18);
    const fileSizeText = formatFileSize(currentFiles.reduce((sum, file) => sum + Number(file.size || 0), 0));
    
    const statusCard = document.getElementById('statusCard');
    const statusIcon = document.getElementById('statusIcon');
    const statusContent = document.getElementById('statusContent');
    
    statusCard.style.display = 'block';
    statusCard.className = 'status-card success';
    statusIcon.innerHTML = icon('izdevas-veiksmigi');
    statusContent.innerHTML = '';
    
    // DROŠI pievieno saturu
    const successText = document.createElement('div');
    safeRender(successText, `${icon('izdevas-veiksmigi')} ${t('backup-complete')}`);
    statusContent.appendChild(successText);
    statusContent.appendChild(document.createElement('br'));
    
    if (lastManifestTxId) {
        const manifestText = document.createElement('div');
        manifestText.innerHTML = '';
        const manifestIconSpan = document.createElement('span');
        manifestIconSpan.innerHTML = icon('manifests');
        manifestText.appendChild(manifestIconSpan);
        manifestText.appendChild(document.createTextNode(` ${t('manifest-link')}: `));
        const manifestLink = document.createElement('a');
        manifestLink.href = `${CONFIG.arweaveGateway}/raw/${encodeURIComponent(lastManifestTxId)}`;
        manifestLink.target = '_blank';
        manifestLink.rel = 'noopener noreferrer';
        manifestLink.textContent = `ar://${lastManifestTxId}`;
        manifestText.appendChild(manifestLink);
        statusContent.appendChild(manifestText);
        statusContent.appendChild(document.createElement('br'));
    }
    
    // DROŠI pievieno failu informāciju
    const filesCount = document.createElement('div');
    safeRender(filesCount, `${icon('fails')} ${t('files-count')}: ${currentFiles.length}`);
    statusContent.appendChild(filesCount);
    
    const filesSize = document.createElement('div');
    safeRender(filesSize, `${icon('fails')} ${t('files-size')}: ${fileSizeText}`);
    statusContent.appendChild(filesSize);
    
    const fileCost = document.createElement('div');
    safeRender(fileCost, `${icon('fails')} ${icon('failu-izmaksas')} ${t('file-cost')}: ${currentFileCostEth} Base ETH`);
    statusContent.appendChild(fileCost);
    
    const manifestCost = document.createElement('div');
    safeRender(manifestCost, `${icon('manifests')} ${icon('failu-izmaksas')} ${t('manifest-cost')}: ${currentManifestCostEth} Base ETH`);
    statusContent.appendChild(manifestCost);
    
    const totalCost = document.createElement('div');
    safeRender(totalCost, `${icon('summa')} ${icon('failu-izmaksas')} ${t('total-cost')}: ${totalCostEth} Base ETH`);
    statusContent.appendChild(totalCost);
}

// ==================================================
// MASTER KEY MODAL (HTML input type=password)
// ==================================================

function promptMasterKey() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;z-index:1000;padding:20px;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:100%;box-sizing:border-box;';
        const title = document.createElement('h2');
        title.textContent = t('key-title');
        title.style.cssText = 'color:#79c0ff;margin-bottom:16px;';
        const description = document.createElement('p');
        description.textContent = t('key-description');
        description.style.cssText = 'color:#b0b8c4;margin-bottom:16px;';
        const form = document.createElement('form');
        form.style.cssText = 'margin:0;';
        const input = document.createElement('input');
        input.type = 'password';
        input.placeholder = t('enter-key');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.style.cssText = 'width:100%;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:16px;margin-bottom:16px;box-sizing:border-box;';
        form.appendChild(input);
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.textContent = t('cancel');
        cancelButton.style.cssText = 'width:100%;padding:12px;background:#30363d;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-bottom:8px;';
        const confirmButton = document.createElement('button');
        confirmButton.type = 'submit';
        confirmButton.textContent = t('confirm-key');
        confirmButton.style.cssText = 'width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;';
        box.appendChild(title);
        box.appendChild(description);
        box.appendChild(form);
        box.appendChild(cancelButton);
        box.appendChild(confirmButton);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const cleanup = () => { overlay.remove(); };
        const submit = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value);
        };
        form.addEventListener('submit', e => { e.preventDefault(); submit(); });
        confirmButton.onclick = submit;
        cancelButton.onclick = () => { cleanup(); resolve(null); };
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { cleanup(); resolve(null); }
        });
        input.focus();
    });
}

async function init() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
        btn.onclick = () => switchLanguage(btn.dataset.lang);
    });
    applyTranslations();
    
    try { CONFIG = await apiJson('/api/config'); } catch (error) { showError(error.message); return; }
    
    const params = new URLSearchParams(window.location.search);
    repoName = params.get('repo');
    if (!repoName) { showError('Nav repo nosaukuma URL parametrā!'); return; }
    
    const repoTitle = document.getElementById('repoTitle');
    if (repoTitle) repoTitle.textContent = `${t('repo-label')}: ${repoName}`;
    
    try {
        const userData = await apiJson('/api/github/user');
        if (!userData.success) { window.location.href = '/api/github/login'; return; }
        githubUser = userData.user;
    } catch (error) { showError(error.message); return; }
    
    if (!window.ethereum) { showError('Lūdzu instalē maku!'); return; }
    
    try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.chainId }] });
        const provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        userAddress = normalizeWallet(await signer.getAddress());
        await loadNFTInfo();
    } catch (error) { showError(error.message); }
    
    if (window.ethereum) {
        window.ethereum.on?.('accountsChanged', async accounts => {
            if (!accounts || accounts.length === 0) { userAddress = null; showError('Maks nav savienots.'); return; }
            try {
                userAddress = normalizeWallet(accounts[0]);
                if (currentJobId) resetBackupState();
                await loadNFTInfo();
            } catch (error) { showError(error.message); }
        });
        window.ethereum.on?.('chainChanged', () => { window.location.reload(); });
    }
}

async function loadNFTInfo() {
    try {
        if (!githubUser || !repoName || !userAddress) return;
        const provider = new ethers.BrowserProvider(window.ethereum);
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        const fullRepoName = `${githubUser}/${repoName}`;
        const repoHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName]));
        tokenId = await nftContract.repositoryTokens(repoHash);
        if (tokenId === 0n) { showError('Nav NFT šim repo!'); return; }
        const nftOwner = await nftContract.ownerOf(tokenId);
        if (nftOwner.toLowerCase() !== userAddress.toLowerCase()) { showError('NFT nepieder šim makam!'); return; }
        
        const tokenElement = document.getElementById('nftTokenId');
        const backupElement = document.getElementById('backupCount');
        const manifestElement = document.getElementById('lastManifest');
        const merkleElement = document.getElementById('lastMerkleRoot');
        if (tokenElement) tokenElement.textContent = tokenId.toString();
        const backupCount = await nftContract.getBackupCount(tokenId);
        if (backupElement) backupElement.textContent = backupCount.toString();
        const lastManifest = await nftContract.getManifestURI(tokenId);
        if (manifestElement) manifestElement.textContent = lastManifest || 'Nav';
        const lastMerkleRoot = await nftContract.getLastMerkleRoot(tokenId);
        if (merkleElement) merkleElement.textContent = lastMerkleRoot || 'Nav';
        
        const button = document.getElementById('startBackupButton');
        if (button) {
            // NEATJAUNO pogu, ja ir aktīvs jobs vai pabeigts backups
            if (currentJobId || backupCompleted) return;
            
            button.style.display = 'block';
            button.disabled = false;
            button.textContent = t('start-backup');
            button.onclick = prepareBackup;
            saveButtonState('start-backup', false, 'prepare');
        }
    } catch (error) { showError(error.message); }
}

async function generateMasterKey() {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    return ethers.hexlify(keyBytes);
}

function showMasterKey(keyToShow) {
    return new Promise(resolve => {
        const modal = document.createElement('div');
        modal.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 1000; padding: 20px;`;
        const box = document.createElement('div');
        box.style.cssText = `background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%; box-sizing: border-box;`;
        const title = document.createElement('h2');
        title.textContent = t('key-title');
        title.style.cssText = 'color:#79c0ff;margin-bottom:16px;';
        const description = document.createElement('p');
        description.textContent = t('key-description');
        description.style.cssText = 'color:#b0b8c4;margin-bottom:16px;';
        const keyBox = document.createElement('div');
        keyBox.textContent = keyToShow;
        keyBox.style.cssText = `background:#0d1117; border:1px solid #30363d; border-radius:8px; padding:16px; margin-bottom:16px; word-break:break-all; font-family:monospace; color:#e6edf3;`;
        const copyButton = document.createElement('button');
        copyButton.textContent = t('copy-key');
        copyButton.style.cssText = `width:100%; padding:12px; background:#238636; color:#fff; border:none; border-radius:8px; font-size:16px; cursor:pointer; margin-bottom:8px;`;
        const downloadButton = document.createElement('button');
        downloadButton.textContent = t('download-key');
        downloadButton.style.cssText = `width:100%; padding:12px; background:#21262d; color:#fff; border:none; border-radius:8px; font-size:16px; cursor:pointer; margin-bottom:8px;`;
        const closeButton = document.createElement('button');
        closeButton.textContent = t('saving-key');
        closeButton.style.cssText = `width:100%; padding:12px; background:#f85149; color:#fff; border:none; border-radius:8px; font-size:16px; cursor:pointer;`;
        box.appendChild(title);
        box.appendChild(description);
        box.appendChild(keyBox);
        box.appendChild(copyButton);
        box.appendChild(downloadButton);
        box.appendChild(closeButton);
        modal.appendChild(box);
        document.body.appendChild(modal);
        copyButton.onclick = async () => { try { await navigator.clipboard.writeText(keyToShow); copyButton.textContent = '✅'; } catch { copyButton.textContent = '❌'; } };
        downloadButton.onclick = () => {
            const blob = new Blob([keyToShow], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `permrepo-master-key-${repoName.replace(/[^\w.-]/g, '_')}.txt`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        };
        closeButton.onclick = () => { modal.remove(); resolve(); };
    });
}

function resetBackupState() {
    currentJobId = null;
    currentFileCostEth = '0';
    currentManifestCostEth = '0';
    currentUnchangedFiles = {};
    currentPreviousHistory = [];
    currentPreviousManifestId = null;
    currentPreviousBackupNumber = null;
    currentPreviousEncryptionIVs = {};
    currentFiles = [];
    currentFileMetadata = [];
    currentMerkleRoot = null;
    currentIV = null;
    currentZipTxId = null;
    currentManifestPayload = null;
    hasDepositedFiles = false;
    hasDepositedManifest = false;
    masterKey = null;
    backupCompleted = false;
    lastManifestTxId = null;
    lastStatusData = null;
    buttonState = null;
}

async function prepareBackup() {
    const button = document.getElementById('startBackupButton');
    if (!button) return;
    button.disabled = true;
    button.textContent = `⏳ ${t('preparing')}`;
    lastStatusData = { type: 'simple', key: 'preparing', statusType: 'progress' };
    setStatus(t('preparing'), 'progress');
    clearError();
    try {
        resetBackupState();
        const result = await apiJson('/api/prepare-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoName, walletAddress: userAddress })
        });
        currentJobId = result.jobId;
        currentUnchangedFiles = result.unchangedFiles || {};
        currentFiles = result.files || [];
        currentPreviousHistory = result.previousHistory || [];
        currentPreviousManifestId = result.previousManifestId || null;
        currentPreviousBackupNumber = result.previousBackupNumber ?? null;
        currentPreviousEncryptionIVs = result.previousEncryptionIVs || {};
        
        if (currentFiles.length === 0) {
            lastStatusData = { type: 'simple', key: 'no-changes', statusType: 'success' };
            setStatus(t('no-changes'), 'success');
            button.disabled = false;
            button.textContent = t('start-backup');
            button.onclick = prepareBackup;
            saveButtonState('start-backup', false, 'prepare');
            return;
        }
        
        const totalBytes = result.totalBytes || 0;
        const sizeText = formatFileSize(totalBytes);
        lastStatusData = { type: 'files', fileCount: currentFiles.length, fileSizeText: sizeText };
        setStatus(
            `${icon('fails')} ${t('files-count')}: ${currentFiles.length}\n` +
            `${icon('fails')} ${t('files-size')}: ${sizeText}`,
            'progress'
        );
        
        button.disabled = false;
        button.textContent = t('deposit-and-upload');
        button.onclick = executeZipUpload;
        saveButtonState('deposit-and-upload', false, 'zip');
    } catch (error) {
        showError(error.message);
        button.disabled = false;
        button.textContent = t('start-backup');
        button.onclick = prepareBackup;
        saveButtonState('start-backup', false, 'prepare');
    }
}

async function executeZipUpload() {
    const button = document.getElementById('startBackupButton');
    if (!button || !currentJobId) { showError('Backup sesija nav atrasta.'); return; }
    button.disabled = true;
    saveButtonState('deposit-and-upload', true, 'zip');
    try {
        const files = currentFiles;
        const backupCount = await getBackupCountFromChain();
        if (backupCount === 0) {
            lastStatusData = { type: 'simple', key: 'generate-key', statusType: 'progress' };
            setStatus(t('generate-key'), 'progress');
            button.textContent = '⏳';
            masterKey = await generateMasterKey();
            await showMasterKey(masterKey);
        } else {
            masterKey = await promptMasterKey();
        }
        if (!isValidMasterKey(masterKey)) {
            masterKey = null;
            showError(t('encrypted-required'));
            button.disabled = false;
            button.textContent = t('deposit-and-upload');
            button.onclick = executeZipUpload;
            saveButtonState('deposit-and-upload', false, 'zip');
            return;
        }
        
        lastStatusData = { type: 'simple', key: 'creating-zip', statusType: 'progress' };
        setStatus(t('creating-zip'), 'progress');
        const zip = new JSZip();
        for (const file of files) {
            if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Nederīgs faila objekts.');
            const binaryString = atob(file.content);
            const fileBuffer = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) fileBuffer[i] = binaryString.codePointAt(i);
            zip.file(file.path, fileBuffer);
        }
        const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
        
        lastStatusData = { type: 'simple', key: 'encrypting', statusType: 'progress' };
        setStatus(t('encrypting'), 'progress');
        const encrypted = await encryptData(zipBuffer, masterKey);
        const encryptedZipData = encrypted.encrypted;
        currentIV = encrypted.iv;
        currentMerkleRoot = calculateMerkleRoot(files);
        currentFileMetadata = files.map(file => ({ path: file.path, hash: file.hash }));
        
        lastStatusData = { type: 'uploading' };
        setStatus(`${icon('upload')} ${t('uploading')}`, 'progress');
        
        const firstResult = await uploadZipBinary({
            jobId: currentJobId,
            encryptedZip: encryptedZipData,
            iv: currentIV,
            fileMetadata: currentFileMetadata
        });
        
        if (firstResult.paymentRequired) {
            currentFileCostEth = firstResult.requiredPaymentEth || '0';
            const requiredWei = ethers.parseEther(currentFileCostEth);
            if (requiredWei <= 0n) throw new Error('Serveris pieprasīja maksājumu ar nulles summu.');
            
            lastStatusData = { type: 'cost', cost: currentFileCostEth };
            setStatus(`${icon('failu-izmaksas')} ${t('costs')}: ${currentFileCostEth} Base ETH`, 'progress');
            button.textContent = '⏳';
            
            const tx = await signer.sendTransaction({ to: CONFIG.treasuryAddress, value: requiredWei });
            lastStatusData = { type: 'waiting' };
            setStatus(t('waiting'), 'progress');
            await tx.wait();
            hasDepositedFiles = true;
            
            lastStatusData = { type: 'uploading' };
            setStatus(`${icon('upload')} ${t('uploading')}`, 'progress');
            const retryResult = await uploadZipBinary({
                jobId: currentJobId,
                encryptedZip: encryptedZipData,
                iv: currentIV,
                fileMetadata: currentFileMetadata,
                paymentTxHash: tx.hash
            });
            
            if (!retryResult.success) throw new Error(retryResult.error || 'ZIP augšupielāde neizdevās.');
            currentZipTxId = retryResult.zipTxId;
        } else {
            currentZipTxId = firstResult.zipTxId;
        }
        
        lastStatusData = { type: 'success', key: 'zip-uploaded' };
        setStatus(`${icon('izdevas-veiksmigi')} ${t('zip-uploaded')}`, 'success');
        button.disabled = false;
        button.textContent = t('deposit-manifest-btn');
        button.onclick = () => finalizeManifest(currentZipTxId, button);
        saveButtonState('deposit-manifest-btn', false, 'manifest');
    } catch (error) {
        masterKey = null;
        if (isUserRejected(error)) showError(t('transaction-cancelled'));
        else showError(error.message);
        button.disabled = false;
        button.textContent = t('deposit-and-upload');
        button.onclick = executeZipUpload;
        saveButtonState('deposit-and-upload', false, 'zip');
    }
}

async function uploadZipBinary({ jobId, encryptedZip, iv, fileMetadata, paymentTxHash = null }) {
    const formData = new FormData();
    formData.append('jobId', jobId);
    formData.append('iv', JSON.stringify(Array.from(iv)));
    formData.append('fileMetadata', JSON.stringify(fileMetadata));
    if (paymentTxHash) formData.append('paymentTxHash', paymentTxHash);
    formData.append('file', new Blob([encryptedZip], { type: 'application/octet-stream' }), 'encrypted.zip');
    
    const response = await fetch('/api/execute-backup', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
    });
    
    let result;
    try { result = await response.json(); } catch { throw new Error(`Servera kļūda: HTTP ${response.status}`); }
    if (!response.ok && !result.success && !result.paymentRequired) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}

async function finalizeManifest(zipTxId, button) {
    if (!currentJobId || !zipTxId) { showError('Trūkst backup darba vai ZIP ID.'); return; }
    button.disabled = true;
    saveButtonState('deposit-manifest-btn', true, 'manifest');
    try {
        lastStatusData = { type: 'uploading' };
        setStatus(`${icon('upload')} ${t('uploading')}`, 'progress');
        let manifestResult = await apiJson('/api/finalize-manifest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: currentJobId,
                zipTxId,
                fileMetadata: currentFileMetadata,
                unchangedFiles: currentUnchangedFiles,
                iv: Array.from(currentIV)
            })
        });
        
        if (manifestResult.paymentRequired) {
            currentManifestPayload = manifestResult.manifest;
            currentManifestCostEth = manifestResult.requiredPaymentEth || '0';
            
            const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestResult.manifest));
            const manifestSize = manifestBytes.length;
            const manifestSizeText = formatFileSize(manifestSize);
            
            lastStatusData = { type: 'manifest-ready', cost: currentManifestCostEth, manifestSizeText };
            setStatus(
                `${icon('manifests')} ${t('manifest-ready')}\n\n` +
                `${t('manifest-size')}: ${manifestSizeText}\n` +
                `${icon('failu-izmaksas')} ${t('costs')}: ${currentManifestCostEth} Base ETH`,
                'progress'
            );
            
            const manifestCostWei = ethers.parseEther(currentManifestCostEth);
            if (manifestCostWei <= 0n) throw new Error('Serveris pieprasīja manifesta maksājumu ar nulles summu.');
            
            if (!hasDepositedManifest) {
                lastStatusData = { type: 'cost', cost: currentManifestCostEth };
                setStatus(`${icon('failu-izmaksas')} ${t('costs')}: ${currentManifestCostEth} Base ETH`, 'progress');
                button.textContent = '⏳';
                const tx = await signer.sendTransaction({ to: CONFIG.treasuryAddress, value: manifestCostWei });
                lastStatusData = { type: 'waiting' };
                setStatus(t('waiting'), 'progress');
                await tx.wait();
                hasDepositedManifest = true;
                
                manifestResult = await apiJson('/api/finalize-manifest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId: currentJobId,
                        zipTxId,
                        fileMetadata: currentFileMetadata,
                        unchangedFiles: currentUnchangedFiles,
                        iv: Array.from(currentIV),
                        paymentTxHash: tx.hash
                    })
                });
            }
        }
        
        if (!manifestResult.success) throw new Error(manifestResult.error || 'Manifesta kļūda.');
        currentManifestCostEth = manifestResult.manifestCostEth || '0';
        currentManifestPayload = manifestResult.manifest || currentManifestPayload;
        
        const manifestTxId = manifestResult.manifestTxId;
        if (!manifestTxId) throw new Error('Serveris neatgrieza manifestTxId.');
        lastManifestTxId = manifestTxId;
        
        lastStatusData = { type: 'signing' };
        setStatus(t('signing'), 'progress');
        const provider = new ethers.BrowserProvider(window.ethereum);
        const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const currentNonce = await readContract.getNonce(tokenId);
        const onChainBackupCount = await readContract.getBackupCount(tokenId);
        const manifestURI = `ar://${manifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        
        const domain = { name: 'PermRepo', version: '1', chainId: Number(CONFIG.chainId), verifyingContract: CONFIG.nftAddress };
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
            merkleRoot: currentMerkleRoot,
            deadline: BigInt(deadline),
            nonce: currentNonce
        };
        
        const signature = await signer.signTypedData(domain, types, value);
        
        const finalizeResult = await apiJson('/api/finalize-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: currentJobId,
                tokenId: tokenId.toString(),
                manifestTxId,
                fileMetadata: currentFileMetadata,
                deadline,
                signature
            })
        });
        
        if (!finalizeResult.success) throw new Error(finalizeResult.error || 'Backup finalizācija neizdevās.');
        masterKey = null;
        backupCompleted = true;
        
        button.style.display = 'block';
        button.disabled = false;
        button.textContent = t('back-home');
        button.onclick = () => { window.location.href = '/'; };
        
        renderCompletedStatus();
    } catch (error) {
        masterKey = null;
        if (isUserRejected(error)) showError(t('transaction-cancelled'));
        else showError(error.message);
        button.disabled = false;
        button.textContent = t('deposit-manifest-btn');
        button.onclick = () => finalizeManifest(zipTxId, button);
        saveButtonState('deposit-manifest-btn', false, 'manifest');
    }
}

async function getBackupCountFromChain() {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
    const count = await nftContract.getBackupCount(tokenId);
    return Number(count);
}

async function encryptData(data, keyHex) {
    if (!isValidMasterKey(keyHex)) throw new Error('Invalid Master Key');
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

// DROŠA setStatus funkcija - novērš XSS
function setStatus(message, type = 'progress') {
    const card = document.getElementById('statusCard');
    const iconElement = document.getElementById('statusIcon');
    const content = document.getElementById('statusContent');
    
    if (!card || !iconElement || !content) return;
    
    const icons = {
        progress: 'upload',
        success: 'izdevas-veiksmigi',
        error: 'kluda'
    };
    
    card.style.display = 'block';
    card.className = `status-card ${type}`;
    
    // Ikonu ieliek droši (no mūsu icon() funkcijas)
    iconElement.innerHTML = icon(icons[type] || 'upload');
    
    // Saturu ieliek DROŠI ar safeRender
    safeRender(content, String(message ?? ''));
}

// DROŠA showError funkcija - novērš XSS
function showError(message) {
    const element = document.getElementById('error');
    if (!element) return;
    element.style.display = 'block';
    
    // Notīra
    element.innerHTML = '';
    
    // Pievieno ikonu (droša)
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = icon('kluda');
    element.appendChild(iconSpan);
    
    // Pievieno tekstu (droši)
    const textSpan = document.createElement('span');
    textSpan.textContent = String(message ?? 'Kļūda');
    element.appendChild(textSpan);
}

function clearError() {
    const element = document.getElementById('error');
    if (!element) return;
    element.style.display = 'none';
    element.innerHTML = '';
}

init();
