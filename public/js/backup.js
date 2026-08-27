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
        'backup-title': 'PermRepo Backups',
        'repo-label': 'Repozitorijs',
        'nft-token': 'NFT Token ID',
        'backup-count': 'Backupu skaits',
        'last-manifest': 'Pēdējais manifests',
        'last-merkle': 'Pēdējā Merkle sakne',
        'start-backup': 'Sākt backupu',
        'preparing': 'Sagatavo backupu...',
        'no-changes': '✅ Nav izmaiņu — visi faili jau ir backupēti!',
        'generate-key': 'Ģenerē master atslēgu...',
        'enter-key': 'Ievadi savu master atslēgu (atstāj tukšu publiskam repo):',
        'deposit-files': 'Iemaksā Treasury par ZIP',
        'deposit-manifest': 'Iemaksā Treasury par manifestu',
        'deposit-and-upload': 'Iemaksāt un augšupielādēt',
        'uploading': 'Augšupielādē...',
        'signing': 'Paraksti transakciju...',
        'backup-complete': '✅ Backups veiksmīgi pabeigts!',
        'manifest-link': '📦 Manifests',
        'file-cost': '💳 Failu izmaksas',
        'manifest-cost': '📄 Manifesta izmaksas',
        'total-cost': '💎 Kopā',
        'files-count': '📦 Faili',
        'files-size': '📦 Failu izmērs'
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
        'no-changes': '✅ No changes — all files already backed up!',
        'generate-key': 'Generating master key...',
        'enter-key': 'Enter your master key (leave empty for public repo):',
        'deposit-files': 'Deposit to Treasury for ZIP',
        'deposit-manifest': 'Deposit to Treasury for manifest',
        'deposit-and-upload': 'Deposit and upload',
        'uploading': 'Uploading...',
        'signing': 'Sign transaction...',
        'backup-complete': '✅ Backup successfully completed!',
        'manifest-link': '📦 Manifest',
        'file-cost': '💳 File cost',
        'manifest-cost': '📄 Manifest cost',
        'total-cost': '💎 Total',
        'files-count': '📦 Files',
        'files-size': '📦 File size'
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
        'no-changes': '✅ Neniu ŝanĝo — ĉiuj dosieroj jam sekurkopiitaj!',
        'generate-key': 'Generante ĉefŝlosilon...',
        'enter-key': 'Enigu vian ĉefŝlosilon (lasu malplena por publika deponejo):',
        'deposit-files': 'Deponi al Treasury por ZIP',
        'deposit-manifest': 'Deponi al Treasury por manifesto',
        'deposit-and-upload': 'Deponi kaj alŝuti',
        'uploading': 'Alŝutante...',
        'signing': 'Subskribante transakcion...',
        'backup-complete': '✅ Sekurkopio sukcese finita!',
        'manifest-link': '📦 Manifesto',
        'file-cost': '💳 Dosierkosto',
        'manifest-cost': '📄 Manifestkosto',
        'total-cost': '💎 Sumo',
        'files-count': '📦 Dosieroj',
        'files-size': '📦 Dosiergrando'
    }
};

function t(key) {
    return translations[currentLanguage][key] || translations.lv[key] || key;
}

function switchLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('permrepo-language', lang);
    applyTranslations();
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
}

async function init() {
    // Valodu pogas
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
        btn.onclick = () => switchLanguage(btn.dataset.lang);
    });
    
    // Sākotnējā tulkošana
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

// ... pārējās funkcijas nemainīgas ...

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

// ... pārējās funkcijas ar t() tulkojumiem ...
