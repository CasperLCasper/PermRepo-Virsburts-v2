// backup.js

const { ethers } = window;

let CONFIG = {};
let userAddress = null;
let signer = null;
let repoName = null;
let tokenId = null;

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
    // 1. Ielādē konfigurāciju
    try {
        const configResponse = await fetch('/api/config');
        CONFIG = await configResponse.json();
    } catch (e) {
        showError('Neizdevās iegūt konfigurāciju');
        return;
    }
    
    // 2. Iegūst repo nosaukumu no URL parametra
    const params = new URLSearchParams(window.location.search);
    repoName = params.get('repo');
    
    if (!repoName) {
        showError('Nav repo nosaukuma URL parametrā!');
        return;
    }
    
    document.getElementById('repoTitle').textContent = 'Repozitorijs: ' + repoName;
    
    // 3. Pārbauda GitHub autorizāciju
    const userResponse = await fetch('/api/github/user');
    const userData = await userResponse.json();
    
    if (!userData.success) {
        window.location.href = '/api/github/login';
        return;
    }
    
    // 4. Savieno MetaMask
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
        
        const repoHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['string'], [repoName])
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

async function startBackup() {
    const button = document.getElementById('startBackupButton');
    button.disabled = true;
    button.textContent = '⏳ Sagatavo...';
    
    setStatus('Sagatavo backupu...');
    
    try {
        // 1. Prepare backup — serveris iegūst failus no GitHub
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
        
        setStatus(`Iegūti ${files.length} faili. Izveido ZIP...`);
        button.textContent = '⏳ ZIP...';
        
        // 2. Klienta pusē izveido ZIP
        const zip = new JSZip();
        for (const file of files) {
            const fileBuffer = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
            zip.file(file.path, fileBuffer);
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
        
        setStatus('ZIP izveidots! Šifrē...');
        button.textContent = '⏳ Šifrē...';
        
        // 3. Šifrē ZIP ar master key (ja lietotājs to ir ievadījis)
        const masterKey = prompt('Ievadi savu master atslēgu (atstāj tukšu publiskam repo):');
        
        let encryptedZip = zipBuffer;
        let iv = null;
        
        if (masterKey && masterKey.trim()) {
            const derivedKey = deriveKeyFromMaster(masterKey.trim(), Number(prepareResult.backupCount) + 1);
            const encrypted = await encryptData(zipBuffer, derivedKey);
            encryptedZip = encrypted.encrypted;
            iv = encrypted.iv;
        }
        
        setStatus('Augšupielādē ZIP...');
        button.textContent = '⏳ Augšupielāde...';
        
        // 4. Augšupielādē ZIP un manifestu caur serveri
        const executeResponse = await fetch('/api/execute-backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repoName,
                files,
                tokenId: tokenId.toString(),
                walletAddress: userAddress,
                encryptedZip: Array.from(encryptedZip),
                iv: iv ? Array.from(iv) : null
            })
        });
        
        const executeResult = await executeResponse.json();
        
        if (!executeResult.success) {
            showError(executeResult.error || 'Kļūda');
            button.disabled = false;
            button.textContent = 'Sākt backupu';
            return;
        }
        
        setStatus('Manifests augšupielādēts! Paraksti transakciju...');
        button.textContent = '⏳ Paraksts...';
        
        // 5. Paraksta addBackup() ar EIP-712
        const provider = new ethers.BrowserProvider(window.ethereum);
        const readContract = new ethers.Contract(CONFIG.nftAddress, NFT_ABI, provider);
        
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const currentNonce = await readContract.getNonce(tokenId);
        const currentBackupCount = await readContract.getBackupCount(tokenId);
        
        const manifestURI = `ar://${executeResult.manifestTxId}`;
        const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
        
        // Merkle sakne no failu hashiem
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
            backupNumber: currentBackupCount + 1n,
            manifestHash,
            merkleRoot,
            deadline: BigInt(deadline),
            nonce: currentNonce
        };
        
        const signature = await signer.signTypedData(domain, types, value);
        
        // 6. Nosūta parakstu uz serveri, lai tas izsauc addBackup()
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
            setStatus('✅ Backups veiksmīgi pabeigts!');
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

function deriveKeyFromMaster(masterKey, backupNumber) {
    const message = `${masterKey}:${backupNumber}`;
    return ethers.keccak256(ethers.toUtf8Bytes(message));
}

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
