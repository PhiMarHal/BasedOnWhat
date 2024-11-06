let contract;
let provider;
let signer;
let userAddress;
let loadingAnimationInterval;

// Cache structure initialization
const wordCache = {
    words: new Array(128),
    users: new Map(),
    lastFullUpdate: 0,
    version: 0,
    pendingUpdates: new Set(),
    processedTransactions: new Set(),
    isProcessingEvents: false,
    pendingTransactions: new Map()
};

function setupPendingTransactionCleanup() {
    // Clean up pending transactions on page load
    const cleanup = async () => {
        const pendingWords = wordCache.words.reduce((acc, word, index) => {
            if (word?.isPending) acc.push(index);
            return acc;
        }, []);

        // Update all pending words with their actual blockchain state
        for (const index of pendingWords) {
            await updateSingleWord(index);
        }
    };

    // Run cleanup on page load
    cleanup();

    // Add cleanup on page unload/refresh
    window.addEventListener('beforeunload', cleanup);
}


function setupEventListener() {
    // Remove any existing listeners
    contract.removeAllListeners("WordUpdated");

    // Set up new listener
    contract.on("WordUpdated", (wordIndex, author, event) => {
        // Prevent duplicate processing
        if (wordCache.processedTransactions.has(event.transactionHash)) {
            return;
        }
        wordCache.processedTransactions.add(event.transactionHash);

        // Add to pending updates
        wordCache.pendingUpdates.add(wordIndex.toNumber());
        processEventQueue();
    });
}

async function processEventQueue() {
    if (wordCache.isProcessingEvents) return;

    try {
        wordCache.isProcessingEvents = true;

        while (wordCache.pendingUpdates.size > 0) {
            const indices = Array.from(wordCache.pendingUpdates);
            wordCache.pendingUpdates.clear();

            // Process updates in smaller batches
            const BATCH_SIZE = 5;
            for (let i = 0; i < indices.length; i += BATCH_SIZE) {
                const batch = indices.slice(i, i + BATCH_SIZE);

                // Update each word in the batch
                await Promise.all(batch.map(async (index) => {
                    try {
                        await updateSingleWord(index);
                    } catch (error) {
                        console.error(`Error updating word ${index}:`, error);
                        // Re-add failed updates to the queue
                        wordCache.pendingUpdates.add(index);
                    }
                }));

                // Add small delay between batches if more remain
                if (i + BATCH_SIZE < indices.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
    } finally {
        wordCache.isProcessingEvents = false;

        // If new updates came in while processing, run again
        if (wordCache.pendingUpdates.size > 0) {
            processEventQueue();
        }
    }
}

async function fetchAllCurrentWords() {
    const wordPromises = [];
    for (let i = 0; i < 128; i++) {
        wordPromises.push(getWordWithAuthorInfo(i));
    }
    return Promise.all(wordPromises);
}

async function initializeApp() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, provider);

        // Set up UI event listeners
        document.getElementById('connect-wallet').addEventListener('click', connectWallet);

        // Initial load of all words
        await loadAllWords();

        // Set up contract event listeners
        setupEventListener();

        // Set up periodic cache maintenance
        setupCacheMaintenance();

        setupPendingTransactionCleanup();

        if (window.ethereum) {
            window.ethereum.on('chainChanged', () => {
                window.location.reload();
            });
        }
    } catch (error) {
        showStatus(`Initialization error: ${error.message}`, 'error');
    }
}

function setupCacheMaintenance() {
    // Clean up old user data periodically
    setInterval(() => {
        const now = Date.now();
        const MAX_USER_CACHE_AGE = 24 * 60 * 60 * 1000; // 24 hours

        for (const [address, data] of wordCache.users) {
            if (now - data.lastUpdated > MAX_USER_CACHE_AGE) {
                wordCache.users.delete(address);
            }
        }

        // Keep processed transactions set from growing too large
        if (wordCache.processedTransactions.size > 1000) {
            wordCache.processedTransactions.clear();
        }
    }, 60 * 60 * 1000); // Run every hour

    // Periodic full refresh to catch any missed updates
    setInterval(async () => {
        const now = Date.now();
        const FORCE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes

        if (now - wordCache.lastFullUpdate >= FORCE_UPDATE_INTERVAL) {
            try {
                await loadAllWords();
            } catch (error) {
                console.error('Periodic refresh failed:', error);
            }
        }
    }, 60 * 1000); // Check every minute
}

function startLoadingAnimation() {
    const wordsContainer = document.getElementById('words-display');
    let dots = 1;

    // Clear any existing content and set up loading display
    wordsContainer.innerHTML = `<div class="loading-dots">.</div>`;
    const dotsElement = wordsContainer.querySelector('.loading-dots');

    // Clear any existing interval
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
    }

    loadingAnimationInterval = setInterval(() => {
        dots = (dots % 3) + 1;
        dotsElement.textContent = '.'.repeat(dots);
    }, 500);
}

function stopLoadingAnimation() {
    if (loadingAnimationInterval) {
        clearInterval(loadingAnimationInterval);
        loadingAnimationInterval = null;
    }
}

async function loadAllWords() {
    startLoadingAnimation();

    try {
        const BATCH_SIZE = 10; // Adjust based on RPC limits
        const DELAY_BETWEEN_BATCHES = 100; // ms

        for (let i = 0; i < 128; i += BATCH_SIZE) {
            const wordBatch = await fetchWordBatch(i, BATCH_SIZE);

            // Collect unique authors from this batch
            const authors = wordBatch
                .map(w => w.author)
                .filter(author => author !== 'unknown');

            // Fetch user info for new authors
            await fetchUserBatch(authors);

            // Update cache with new word data
            wordBatch.forEach(({ index, word, author }) => {
                const userInfo = wordCache.users.get(author) || { name: '', tribe: '0' };
                wordCache.words[index] = {
                    word: word || '[...]',
                    authorAddress: author,
                    authorName: userInfo.name,
                    tribe: userInfo.tribe
                };
            });

            // Add delay between batches to avoid rate limits
            if (i + BATCH_SIZE < 128) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
        }

        wordCache.lastFullUpdate = Date.now();
        wordCache.version++;
        await updateWordsDisplay();

    } catch (error) {
        console.error('Error in loadAllWords:', error);
        // If we have cached data, use it
        if (wordCache.words.some(w => w)) {
            await updateWordsDisplay();
            showStatus('Using cached data due to network issues', 'warning');
        } else {
            showStatus('Failed to load words', 'error');
        }
    } finally {
        stopLoadingAnimation();
    }
}

async function fetchWordBatch(startIndex, batchSize) {
    const promises = [];
    for (let i = 0; i < batchSize && (startIndex + i) < 128; i++) {
        promises.push(contract.getLastWord(startIndex + i)
            .then(([word, author]) => ({
                index: startIndex + i,
                word,
                author
            }))
            .catch(error => ({
                index: startIndex + i,
                error,
                // Use cached data if available
                word: wordCache.words[startIndex + i]?.word || '[...]',
                author: wordCache.words[startIndex + i]?.authorAddress || 'unknown'
            }))
        );
    }
    return Promise.all(promises);
}

async function fetchUserBatch(addresses) {
    // Filter out addresses we already have cached
    const uniqueAddresses = [...new Set(addresses)].filter(addr =>
        addr !== 'unknown' &&
        addr !== ethers.constants.AddressZero &&
        !wordCache.users.has(addr)
    );

    const promises = uniqueAddresses.map(address =>
        contract.users(address)
            .then(user => ({
                address,
                name: user.name,
                tribe: user.tribe.toString()
            }))
            .catch(() => ({
                address,
                name: '',
                tribe: '0'  // Default tribe
            }))
    );

    const results = await Promise.all(promises);

    // Update user cache
    results.forEach(result => {
        wordCache.users.set(result.address, {
            name: result.name,
            tribe: result.tribe,
            lastUpdated: Date.now()
        });
    });

    return results;
}

async function updateSingleWord(index) {
    try {
        const [word, author] = await contract.getLastWord(index);

        // Only fetch user info if we don't have it cached
        if (author !== 'unknown' && !wordCache.users.has(author)) {
            await fetchUserBatch([author]);
        }

        const userInfo = wordCache.users.get(author) || { name: '', tribe: '0' };
        const newWordInfo = {
            word: word || '[...]',
            authorAddress: author,
            authorName: userInfo.name,
            tribe: userInfo.tribe
        };

        // Only update if the word actually changed
        if (!wordCache.words[index] ||
            JSON.stringify(wordCache.words[index]) !== JSON.stringify(newWordInfo)) {

            wordCache.words[index] = newWordInfo;
            wordCache.version++;
            await updateWordsDisplay();
        }

    } catch (error) {
        console.error(`Error updating word ${index}:`, error);
        // Keep using cached version if available
        if (wordCache.words[index]) {
            showStatus('Using cached version due to network issues', 'warning');
        }
    }
}

async function updateWordsDisplay() {
    const wordsContainer = document.getElementById('words-display');
    wordsContainer.innerHTML = '';

    wordCache.words.forEach((wordInfo, index) => {
        if (!wordInfo) return; // Skip empty cache entries

        if (index > 0) {
            wordsContainer.appendChild(document.createTextNode(' '));
        }

        const wordSpan = document.createElement('span');
        wordSpan.className = 'word';
        if (wordInfo.isPending) {
            wordSpan.classList.add('word-pending');
        }
        wordSpan.textContent = wordInfo.word;
        wordSpan.dataset.tribe = wordInfo.isPending ? 'pending' : wordInfo.tribe;
        wordSpan.dataset.index = index;
        wordSpan.dataset.author = wordInfo.authorName || wordInfo.authorAddress;

        // Disable click handler for pending words
        if (!wordInfo.isPending) {
            wordSpan.onclick = () => showWordPopup(index, wordInfo);
        }

        wordsContainer.appendChild(wordSpan);
    });
}

async function showWordPopup(wordIndex, wordInfo) {
    if (!userAddress) {
        showStatus('Please connect your wallet first', 'error');
        return;
    }

    // Remove any existing popup
    const existingPopup = document.querySelector('.word-popup');
    if (existingPopup) {
        existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.className = 'word-popup';

    const content = document.createElement('div');
    content.className = 'popup-content';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'popup-input';
    input.placeholder = 'Enter new word';
    input.maxLength = 32;

    const button = document.createElement('button');
    button.className = 'popup-button';
    button.textContent = 'Contribute';

    const info = document.createElement('div');
    info.className = 'word-info';
    info.textContent = `#${wordIndex}, by ${wordInfo.authorName || wordInfo.authorAddress}`;

    content.appendChild(input);
    content.appendChild(button);
    content.appendChild(info);
    popup.appendChild(content);

    button.addEventListener('click', async () => {
        const newWord = input.value.trim();
        if (!newWord) {
            showStatus('Please enter a word', 'error');
            return;
        }

        try {
            if (!validateWord(newWord)) {
                throw new Error('Word must contain only letters, with optional punctuation at the end');
            }

            setLoading(true);

            // Store the original word info before optimistic update
            const originalWordInfo = wordCache.words[wordIndex] ? { ...wordCache.words[wordIndex] } : null;

            // Optimistically update the display
            const optimisticWordInfo = {
                word: newWord,
                authorAddress: userAddress,
                authorName: (await contract.users(userAddress)).name || userAddress,
                tribe: 'pending',
                isPending: true
            };

            // Update cache with optimistic data
            wordCache.words[wordIndex] = optimisticWordInfo;
            await updateWordsDisplay();

            // Close popup immediately
            popup.remove();

            try {
                // Send transaction
                const tx = await contract.contribute(wordIndex, newWord);
                showStatus('Transaction sent! Waiting for confirmation...', 'success');

                try {
                    // Wait for transaction confirmation
                    await tx.wait();
                    showStatus('Word contributed successfully!', 'success');
                    // Only now update with real data from blockchain
                    await updateSingleWord(wordIndex);
                } catch (confirmError) {
                    showStatus('Transaction failed or was dropped', 'error');
                    // Revert to original state and fetch current blockchain state
                    if (originalWordInfo) {
                        wordCache.words[wordIndex] = originalWordInfo;
                        await updateWordsDisplay();
                    }
                    await updateSingleWord(wordIndex);
                }

            } catch (txError) {
                // Transaction was rejected at wallet level
                showStatus('Transaction cancelled', 'error');
                // Revert to original state and fetch current blockchain state
                if (originalWordInfo) {
                    wordCache.words[wordIndex] = originalWordInfo;
                    await updateWordsDisplay();
                }
                await updateSingleWord(wordIndex);
            }

        } catch (error) {
            // Parse the error message
            let errorMsg = 'Error: ';
            if (error.code === 'ACTION_REJECTED' || error.message.includes('rejected')) {
                errorMsg += 'Transaction cancelled';
            } else if (error.message.includes('user rejected')) {
                errorMsg += 'Transaction cancelled';
            } else {
                // For other errors, give a concise message
                errorMsg += error.message.split('\n')[0].substring(0, 50); // Take first line, max 50 chars
                if (error.message.length > 50) errorMsg += '...';
            }

            showStatus(errorMsg, 'error');

            // Revert to original state if transaction was cancelled
            if (originalWordInfo) {
                wordCache.words[wordIndex] = originalWordInfo;
            } else {
                // If no original state, fetch from blockchain
                await updateSingleWord(wordIndex);
            }
            await updateWordsDisplay();

        } finally {
            setLoading(false);
        }
    });

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            button.click();
        }
    });

    // Close popup when clicking outside
    popup.addEventListener('click', (e) => {
        if (e.target === popup) {
            popup.remove();
        }
    });

    document.body.appendChild(popup);
    popup.style.display = 'flex';
    input.focus();
}

async function getWordWithAuthorInfo(index) {
    try {
        const [word, author] = await contract.getLastWord(index);
        let authorName = '';
        let tribe = '0'; // We should only default to this if we really can't get the info

        // Only proceed with user info fetch if we have a valid author
        if (author && author !== ethers.constants.AddressZero) {
            try {
                // Get user info directly
                const user = await contract.users(author);
                // Make sure we got valid data back
                if (user) {
                    authorName = user.name || '';
                    // Only set tribe if we got a valid number back
                    if (user.tribe != null && !isNaN(user.tribe)) {
                        tribe = user.tribe.toString();
                    }
                }
            } catch (error) {
                console.error(`Error fetching user info for word ${index}, author ${author}:`, error);
                // Don't default to tribe 0, keep trying to fetch
                throw error; // Let the outer try-catch handle it
            }
        }

        return {
            word: word || '[...]',
            authorAddress: author === ethers.constants.AddressZero ?
                'unknown' :
                `${author.slice(0, 6)}...${author.slice(-4)}`,
            authorName,
            tribe
        };
    } catch (error) {
        console.error(`Error fetching word ${index}:`, error);
        // Try one more time before giving up
        try {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            const [word, author] = await contract.getLastWord(index);
            const user = await contract.users(author);
            return {
                word: word || '[...]',
                authorAddress: author === ethers.constants.AddressZero ?
                    'unknown' :
                    `${author.slice(0, 6)}...${author.slice(-4)}`,
                authorName: user.name || '',
                tribe: user.tribe.toString()
            };
        } catch (retryError) {
            console.error(`Retry failed for word ${index}:`, retryError);
            // Only now do we return a default tribe
            return {
                word: '[error]',
                authorAddress: 'unknown',
                authorName: '',
                tribe: '0'  // Last resort default
            };
        }
    }
}

function setLoading(isLoading) {
    const buttons = document.querySelectorAll('button');
    const inputs = document.querySelectorAll('input');

    buttons.forEach(button => {
        button.disabled = isLoading;
        button.classList.toggle('loading', isLoading);
    });

    inputs.forEach(input => {
        input.disabled = isLoading;
    });
}

function showStatus(message, type = 'info') {
    const statusElement = document.getElementById('status-messages');

    // Clean up the message
    let cleanMessage = message;
    if (message.includes('0x')) {
        // Remove transaction hashes and long hex strings
        cleanMessage = message.replace(/0x[a-fA-F0-9]{10,}/g, '(tx)');
    }
    // Trim long messages
    if (cleanMessage.length > 100) {
        cleanMessage = cleanMessage.substring(0, 97) + '...';
    }

    statusElement.textContent = cleanMessage;
    statusElement.className = type + ' visible';

    setTimeout(() => {
        statusElement.className = '';
    }, 5000);
}

async function switchNetwork() {
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x2105' }], // 8453 in hex for Base
        });
    } catch (switchError) {
        // This error code indicates that the chain has not been added to MetaMask
        if (switchError.code === 4902) {
            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: '0x2105',
                        chainName: 'Base',
                        nativeCurrency: {
                            name: 'ETH',
                            symbol: 'ETH',
                            decimals: 18
                        },
                        rpcUrls: ['https://base-rpc.publicnode.com'],
                        blockExplorerUrls: ['https://basescan.org']
                    }]
                });
            } catch (addError) {
                throw new Error('Could not add Base network to wallet');
            }
        } else {
            throw switchError;
        }
    }
}

async function connectWallet() {
    try {
        if (typeof window.ethereum === 'undefined') {
            throw new Error('No Web3 wallet detected');
        }

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        userAddress = accounts[0];

        // Check if we're on Base
        const chainId = await window.ethereum.request({ method: 'eth_chainId' });
        if (chainId !== '0x2105') { // Base Mainnet
            await switchNetwork();
        }

        // Set up Web3 provider and contract with signer
        const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = web3Provider.getSigner();
        contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, signer);

        // Update wallet display
        await updateWalletDisplay();

    } catch (error) {
        showStatus(`Wallet connection error: ${error.message}`, 'error');
    }
}

async function updateWalletDisplay() {
    const walletInfo = document.getElementById('wallet-info');

    if (!userAddress) {
        walletInfo.innerHTML = '<button id="connect-wallet">Connect Wallet</button>';
        document.getElementById('connect-wallet').addEventListener('click', connectWallet);
        return;
    }

    try {
        // Check if user has registered a name
        const user = await contract.users(userAddress);
        const displayText = user.name ? user.name : `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;

        walletInfo.innerHTML = `<span class="wallet-address">${displayText}</span>`;

    } catch (error) {
        console.error('Error fetching user info:', error);
        walletInfo.innerHTML = `<span class="wallet-address">${userAddress.slice(0, 6)}...${userAddress.slice(-4)}</span>`;
    }
}

function validateWord(word) {
    // First check if the word is empty or too long
    if (!word || word.length > 32) return false;

    // If word is only one character, it must be a letter
    if (word.length === 1) return /^[a-zA-Z]$/.test(word);

    // For longer words:
    // 1. All characters except the last must be letters
    // 2. Last character can be a letter or allowed punctuation
    const allButLast = word.slice(0, -1);
    const lastChar = word.slice(-1);

    return /^[a-zA-Z]+$/.test(allButLast) &&
        /^[a-zA-Z,\.;!?]$/.test(lastChar);
}

async function registerUser() {
    try {
        const name = document.getElementById('name-input').value.trim();
        const tribe = document.getElementById('tribe-select').value;

        if (!name) throw new Error('Please enter a name');
        if (name.length > 32) throw new Error('Name must be 32 characters or less');

        // Validate name characters (only letters allowed)
        if (!/^[a-zA-Z]+$/.test(name)) {
            throw new Error('Name must contain only letters');
        }

        setLoading(true);
        const tx = await contract.register(name, tribe);
        await tx.wait();

        document.getElementById('user-info').style.display = 'none';
        showStatus(`Successfully registered as ${name}`, 'success');
        highlightUserTribe(tribe);

    } catch (error) {
        showStatus(`Registration error: ${error.message}`, 'error');
    } finally {
        setLoading(false);
    }
}

async function submitWord() {
    try {
        const wordIndex = parseInt(document.getElementById('word-index').value);
        const newWord = document.getElementById('new-word').value.trim();

        // Validate inputs
        if (isNaN(wordIndex) || wordIndex < 0 || wordIndex >= 128) {
            throw new Error('Word index must be between 0 and 127');
        }
        if (!newWord) throw new Error('Please enter a word');
        if (newWord.length > 32) throw new Error('Word must be 32 characters or less');

        // Validate word characters (only letters allowed)
        if (!/^[a-zA-Z]+$/.test(newWord)) {
            throw new Error('Word must contain only letters');
        }

        setLoading(true);
        const tx = await contract.contribute(wordIndex, newWord);
        await tx.wait();

        showStatus('Word submitted successfully', 'success');
        await updateWordsDisplay();

        // Clear input fields
        document.getElementById('word-index').value = '';
        document.getElementById('new-word').value = '';

    } catch (error) {
        showStatus(`Submission error: ${error.message}`, 'error');
    } finally {
        setLoading(false);
    }
}


function highlightUserTribe(tribe) {
    // Remove any existing tribe highlights
    document.querySelectorAll('.tribe-selected').forEach(el => {
        el.classList.remove('tribe-selected');
    });

    // Add highlight to user's tribe in the select element
    const tribeOption = document.querySelector(`#tribe-select option[value="${tribe}"]`);
    if (tribeOption) {
        tribeOption.classList.add('tribe-selected');
    }
}



// Initialize app when page loads
window.addEventListener('load', initializeApp);

// Update event handler for account changes
if (window.ethereum) {
    window.ethereum.on('accountsChanged', async (accounts) => {
        if (accounts.length === 0) {
            userAddress = null;
            await updateWalletDisplay();
        } else {
            userAddress = accounts[0];
            await connectWallet();
        }
    });
}

