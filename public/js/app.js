// app.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let githubUser = null;
let currentLanguage = localStorage.getItem('permrepo-language') || 'lv';
let reposData = [];
let selectedRepoName = null;

const NFT_ABI = [
    "function mintRepository(address recipient, string calldata repository, string calldata uri) external returns (uint256)",
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(bytes32 githubHash) external view returns (bool)",
    "function subscribe(bytes32 githubHash) external",
    "function subscriptionPrice() external view returns (uint256)",
    "function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256)",
    "function getRemainingTime(bytes32 githubHash) external view returns (uint256)"
];

const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)"
];

const translations = {
    lv: {
        subtitle: 'GitHub repo backupi uz Arweave',
        'connect-github': 'Savienot ar GitHub',
        user: 'Lietotājs',
        logout: 'Izrakstīties',
        wallet: 'Maks',
        'connect-wallet': 'Savienot maku',
        repository: 'Repozitorijs',
        'select-repo': 'Izvēlies repozitoriju...',
        'open-backup': 'Izveidot Backupu',
        'mint-nft': 'Izveidot NFT',
        'nft-linked': '✅ NFT ir piesaistīts šim repozitorijam',
        'no-nft': '❌ Šim repozitorijam nav NFT',
        'subscription-active': '📅 Abonements: AKTĪVS',
        'subscription-expired': '📅 Abonements: BEIDZIES — ATJAUNOT',
        'days': 'dienas',
        'wallet-connected': 'Maks savienots'
    },
    en: {
        subtitle: 'GitHub repo backups to Arweave',
        'connect-github': 'Connect with GitHub',
        user: 'User',
        logout: 'Log out',
        wallet: 'Wallet',
        'connect-wallet': 'Connect wallet',
        repository: 'Repository',
        'select-repo': 'Select repository...',
        'open-backup': 'Create Backup',
        'mint-nft': 'Mint NFT',
        'nft-linked': '✅ NFT is linked to this repository',
        'no-nft': '❌ This repository has no NFT',
        'subscription-active': '📅 Subscription: ACTIVE',
        'subscription-expired': '📅 Subscription: EXPIRED — RENEW',
        'days': 'days',
        'wallet-connected': 'Wallet connected'
    },
    eo: {
        subtitle: 'GitHub-repozitorio sekurkopioj al Arweave',
        'connect-github': 'Konekti kun GitHub',
        user: 'Uzanto',
        logout: 'Elsaluti',
        wallet: 'Monujo',
        'connect-wallet': 'Konekti monujon',
        repository: 'Deponejo',
        'select-repo': 'Elektu deponejon...',
        'open-backup': 'Krei Sekurkopion',
        'mint-nft': 'Krei NFT',
        'nft-linked': '✅ NFT estas ligita al ĉi tiu deponejo',
        'no-nft': '❌ Ĉi tiu deponejo ne havas NFT',
        'subscription-active': '📅 Abono: AKTIVA',
        'subscription-expired': '📅 Abono: FINIĜIS — RENOVIGI',
        'days': 'tagoj',
        'wallet-connected': 'Monujo konektita'
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
    
    if (reposData.length > 0) {
        loadRepos();
    }
    
    if (selectedRepoName) {
        checkRepoStatus(selectedRepoName);
    }
    
    if (userAddress) {
        const walletButton = document.getElementById('connectWalletButton');
        walletButton.textContent = t('wallet-connected');
    }
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    
    checkSubscription();
}

async function init() {
    // Valodu pogas — atzīmē aktīvo
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
        btn.onclick = () => switchLanguage(btn.dataset.lang);
    });
    
    // Sākotnējā tulkošana
    applyTranslations();
    
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (_e) {
        showError('Neizdevās iegūt konfigurāciju');
        return;
    }
    
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (userData.success) {
        githubUser = userData.user;
        document.getElementById('userSection').style.display = 'block';
        document.getElementById('userName').textContent = userData.user;
        document.getElementById('logoutButton').onclick = async () => {
            await fetch('/api/github/logout');
            window.location.reload();
        };
        
        await checkSubscription();
        await connectWallet();
    } else {
        document.getElementById('authSection').style.display = 'block';
        document.getElementById('loginButton').onclick = () => {
            window.location.href = '/api/github/login';
        };
    }
}

async function checkSubscription() {
    try {
        const response = await fetch('/api/subscription/status');
        const data = await response.json();
        
        if (data.success) {
            const button = document.getElementById('subscriptionButton');
            document.getElementById('subscriptionSection').style.display = 'block';
            
            if (data.isSubscribed) {
                const daysLeft = Math.floor(Number(data.remainingTime) / 86400);
                button.textContent = `${t('subscription-active')} (${daysLeft} ${t('days')})`;
                button.className = 'subscription-button active';
                button.disabled = true;
            } else {
                button.textContent = t('subscription-expired');
                button.className = 'subscription-button inactive';
                button.disabled = false;
                button.onclick = purchaseSubscription;
            }
        }
    } catch (e) {
        console.error('Abonementa pārbaudes kļūda:', e);
    }
}

async function purchaseSubscription() {
    try {
        setStatus('Apstiprina USDC atļauju...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const providerSigner = await provider.getSigner();
        
        const subscriptionContract = new ethers.Contract(CONFIG.subscriptionAddress, SUBSCRIPTION_ABI, provider);
        const price = await subscriptionContract.subscriptionPrice();
        
        const usdcContract = new ethers.Contract(CONFIG.usdcAddress, USDC_ABI, providerSigner);
        const approveTx = await usdcContract.approve(CONFIG.subscriptionAddress, price);
        await approveTx.wait();
        
        setStatus('Iegādājas abonementu...');
        
        const githubHash = ethers.keccak256(ethers.toUtf8Bytes(githubUser));
        const subscribeTx = await subscriptionContract.connect(providerSigner).subscribe(githubHash);
        await subscribeTx.wait();
        
        setStatus('✅ Abonements iegādāts!');
        await checkSubscription();
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
    }
}

async function connectWallet() {
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
        
        document.getElementById('walletSection').style.display = 'block';
        document.getElementById('walletAddress').textContent = userAddress;
        
        const walletButton = document.getElementById('connectWalletButton');
        walletButton.textContent = t('wallet-connected');
        walletButton.disabled = true;
        
        await loadRepos();
    } catch (e) {
        showError(e.message);
    }
}

async function loadRepos() {
    try {
        if (reposData.length === 0) {
            const response = await fetch('/api/github/repos');
            const data = await response.json();
            
            if (!data.success || data.repos.length === 0) {
                showError('Nav atrasts neviens repozitorijs');
                return;
            }
            
            reposData = data.repos;
        }
        
        document.getElementById('repoSection').style.display = 'block';
        const select = document.getElementById('repoSelect');
        select.innerHTML = `<option value="">${t('select-repo')}</option>`;
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        for (const repo of reposData) {
            const fullRepoName = `${githubUser}/${repo.name}`;
            const repoHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName])
            );
            const tokenId = await nftContract.repositoryTokens(repoHash);
            const hasNFT = tokenId !== 0n;
            
            const option = document.createElement('option');
            option.value = repo.name;
            option.textContent = `${hasNFT ? '✅' : '❌'} ${repo.name}${repo.private ? ' 🔒' : ''}`;
            option.className = hasNFT ? 'repo-option-nft' : 'repo-option-no-nft';
            select.appendChild(option);
        }
        
        if (selectedRepoName) {
            select.value = selectedRepoName;
        }
        
        select.onchange = async () => {
            if (select.value) {
                selectedRepoName = select.value;
                await checkRepoStatus(select.value);
            } else {
                selectedRepoName = null;
                document.getElementById('repoActions').style.display = 'none';
            }
        };
        
    } catch (e) {
        showError(e.message);
    }
}

async function checkRepoStatus(repoName) {
    try {
        selectedRepoName = repoName;
        
        const fullRepoName = `${githubUser}/${repoName}`;
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [fullRepoName])
        );
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        const repoActions = document.getElementById('repoActions');
        const actionButton = document.getElementById('actionButton');
        const repoStatus = document.getElementById('repoStatus');
        
        repoActions.style.display = 'block';
        
        if (tokenId !== 0n) {
            repoStatus.textContent = t('nft-linked');
            repoStatus.className = 'repo-status-display has-nft';
            actionButton.textContent = t('open-backup');
            actionButton.className = 'sign-button backup-button';
            actionButton.style.display = 'block';
            actionButton.onclick = () => {
                window.location.href = `/backup.html?repo=${encodeURIComponent(repoName)}`;
            };
        } else {
            repoStatus.textContent = t('no-nft');
            repoStatus.className = 'repo-status-display no-nft';
            actionButton.textContent = t('mint-nft');
            actionButton.className = 'sign-button';
            actionButton.style.display = 'block';
            actionButton.onclick = () => mintNFT(repoName);
        }
        
    } catch (e) {
        showError(e.message);
    }
}

async function mintNFT(repoName) {
    try {
        setStatus('Izveido NFT...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const nftSigner = await provider.getSigner();
        const nftWrite = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, nftSigner);
        
        const fullRepoName = `${githubUser}/${repoName}`;
        const nftImageURI = 'ar://placeholder';
        
        const tx = await nftWrite.mintRepository(userAddress, fullRepoName, nftImageURI);
        await tx.wait();
        
        setStatus('✅ NFT izveidots!');
        await loadRepos();
        await checkRepoStatus(repoName);
        
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
    }
}

function setStatus(msg) { 
    document.getElementById('status').textContent = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

init();
