// merkle.js

import { ethers } from 'ethers';

export function calculateMerkleRoot(files) {
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

export const submitBackupWithMerkle = async (params) => {
    const { 
        tokenId, 
        manifestTxId, 
        files, 
        deadline, 
        signature, 
        nftContract, 
        readContract 
    } = params;

    const merkleRoot = calculateMerkleRoot(files);
    const manifestURI = `ar://${manifestTxId}`;
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));

    const tx = await nftContract.addBackup(
        tokenId,
        manifestHash,
        merkleRoot,
        manifestURI,
        deadline,
        signature
    );

    await tx.wait();
    return tx.hash;
}
