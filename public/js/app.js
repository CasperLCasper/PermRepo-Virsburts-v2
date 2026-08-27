// app.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let githubUser = null;

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

async function init() {
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
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
    } catch (e) {
        console.error('Abonementa pārbaudes kļūda:', e);
    }
}

async function purchaseSubscription() {
    try {
        setStatus('Apstiprina USDC atļauju...');
        
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        
        const subscriptionContract = new ethers.Contract(CONFIG.subscriptionAddress, SUBSCRIPTION_ABI, provider);
        const price = await subscriptionContract.subscriptionPrice();
        
        const usdcContract = new ethers.Contract(CONFIG.usdcAddress, USDC_ABI, signer);
        const approveTx = await usdcContract.approve(CONFIG.subscriptionAddress, price);
        await approveTx.wait();
        
        setStatus('Iegādājas abonementu...');
        
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
    try {
        const response = await fetch('/api/github/repos');
        const data = await response.json();
        
        if (!data.success || data.repos.length === 0) {
            showError('Nav atrasts neviens repozitorijs');
            return;
        }
        
        document.getElementById('repoSection').style.display = 'block';
        const select = document.getElementById('repoSelect');
        select.innerHTML = '<option value="">Izvēlies repozitoriju...</option>';
        
        for (const repo of data.repos) {
            const option = document.createElement('option');
            option.value = repo.name;
            option.textContent = repo.name + (repo.private ? ' 🔒' : '');
            select.appendChild(option);
        }
        
        select.onchange = async () => {
            if (select.value) {
                await checkRepoStatus(select.value);
            } else {
                document.getElementById('repoActions').style.display = 'none';
            }
        };
        
    } catch (e) {
        showError(e.message);
    }
}

async function checkRepoStatus(repoName) {
    try {
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
            repoStatus.textContent = '✅ NFT piesaistīts';
            repoStatus.className = 'status status-has-nft';
            actionButton.textContent = 'Atvērt backupu';
            actionButton.style.display = 'block';
            actionButton.onclick = () => {
                window.location.href = `/backup.html?repo=${encodeURIComponent(repoName)}`;
            };
        } else {
            repoStatus.textContent = '❌ Nav NFT';
            repoStatus.className = 'status status-no-nft';
            actionButton.textContent = 'Izveidot NFT';
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
        const signer = await provider.getSigner();
        const nftWrite = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, signer);
        
        const fullRepoName = `${githubUser}/${repoName}`;
        const nftImageURI = 'ar://placeholder';
        
        const tx = await nftWrite.mintRepository(userAddress, fullRepoName, nftImageURI);
        await tx.wait();
        
        setStatus('✅ NFT izveidots!');
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
