// app.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let githubUser = null;

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

const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)"
];

async function init() {
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        showError('Neizdevās iegūt konfigurāciju');
        return;
    }
    
    // GitHub auth
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
    const response = await fetch('/api/subscription/status');
    const data = await response.json();
    
    if (data.success) {
        const button = document.getElementById('subscriptionButton');
        document.getElementById('subscriptionSection').style.display = 'block';
        
        if (data.isSubscribed) {
            const daysLeft = Math.floor(Number(data.remainingTime) / 86400);
            button.textContent = `📅 Abonements: AKTĪVS (${daysLeft} dienas)`;
            button.className = 'subscription-button active';
            button.disabled = true;
        } else {
            button.textContent = '📅 Abonements: BEIDZIES — ATJAUNOT';
            button.className = 'subscription-button inactive';
            button.disabled = false;
            button.onclick = purchaseSubscription;
        }
    }
}

async function purchaseSubscription() {
    try {
        setStatus('Apstiprina USDC atļauju...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        
        const subscriptionContract = new ethers.Contract(CONFIG.subscriptionAddress, SUBSCRIPTION_ABI, provider);
        const price = await subscriptionContract.subscriptionPrice();
        
        // 1. Apstiprina USDC
        const usdcContract = new ethers.Contract(CONFIG.usdcAddress, USDC_ABI, signer);
        const approveTx = await usdcContract.approve(CONFIG.subscriptionAddress, price);
        await approveTx.wait();
        
        setStatus('Iegādājas abonementu...');
        
        // 2. Iegādājas abonementu
        const githubHash = ethers.keccak256(ethers.toUtf8Bytes(githubUser));
        const subscribeTx = await subscriptionContract.connect(signer).subscribe(githubHash);
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
        
        document.getElementById('walletSection').style.display = 'block';
        document.getElementById('walletAddress').textContent = userAddress.substring(0, 10) + '...';
        
        await loadRepos();
    } catch (e) {
        showError(e.message);
    }
}

async function loadRepos() {
    const response = await fetch('/api/github/repos');
    const data = await response.json();
    
    if (!data.success || data.repos.length === 0) {
        showError('Nav atrasts neviens repozitorijs');
        return;
    }
    
    document.getElementById('repoSection').style.display = 'block';
    const repoList = document.getElementById('repoList');
    repoList.innerHTML = '';
    
    const provider = new ethers.BrowserProvider(window.ethereum);
    const nftContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
    
    for (const repo of data.repos) {
        const repoItem = document.createElement('div');
        repoItem.className = 'repo-item';
        
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repo.name])
        );
        const tokenId = await nftContract.repositoryTokens(repoHash);
        
        const hasNFT = tokenId !== 0n;
        const statusClass = hasNFT ? 'status-has-nft' : 'status-no-nft';
        const statusText = hasNFT ? '✅ NFT piesaistīts' : '❌ Nav NFT';
        
        repoItem.innerHTML = `
            <div class="repo-info">
                <div class="repo-name">${repo.name} ${repo.private ? '🔒' : ''}</div>
                <div class="repo-desc">${repo.description || ''}</div>
                <div class="repo-status ${statusClass}">${statusText}</div>
            </div>
            ${hasNFT ? 
                `<button class="mint-button" onclick="openBackup('${repo.name}', '${tokenId}')">Atvērt backupu</button>` :
                `<button class="mint-button" onclick="mintNFT('${repo.name}')">Izveidot NFT</button>`
            }
        `;
        
        repoList.appendChild(repoItem);
    }
}

async function mintNFT(repoName) {
    try {
        setStatus('Izveido NFT...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const nftWrite = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signer);
        
        const nftImageURI = 'ar://placeholder';
        const tx = await nftWrite.mintRepository(userAddress, repoName, nftImageURI);
        await tx.wait();
        
        setStatus('✅ NFT izveidots!');
        await loadRepos();
    } catch (e) {
        if (e.code === 'ACTION_REJECTED') {
            showError('Transakcija atcelta');
        } else {
            showError(e.message);
        }
    }
}

async function openBackup(repoName, tokenId) {
    setStatus(`Backups repo: ${repoName} (NFT #${tokenId})`);
    // Šeit būs backup loģika
}

function setStatus(msg) { 
    document.getElementById('status').textContent = msg; 
}

function showError(msg) { 
    document.getElementById('error').textContent = msg; 
}

window.mintNFT = mintNFT;
window.openBackup = openBackup;

init();
