let contract;
let provider;
let signer;
let userAddress;
let cachedWords = new Array(128);
let loadingAnimationInterval;
let eventProcessingQueue = new Set();
let isProcessingEvents = false;

async function setupEventListener() {
    contract.on("WordUpdated", (wordIndex, author, event) => {
        // Add the word index to our processing queue
        eventProcessingQueue.add(wordIndex.toNumber());
        processEventQueue();
    });
}

async function processEventQueue() {
    // If we're already processing events, return
    if (isProcessingEvents) return;

    try {
        isProcessingEvents = true;

        while (eventProcessingQueue.size > 0) {
            // Get all current indices to process
            const indices = Array.from(eventProcessingQueue);
            eventProcessingQueue.clear();

            // Update all words in parallel
            await Promise.all(indices.map(async (index) => {
                try {
                    await updateSingleWord(index);
                } catch (error) {
                    console.error(`Error updating word ${index}:`, error);
                }
            }));
        }
    } finally {
        isProcessingEvents = false;

        // Check if new events came in while we were processing
        if (eventProcessingQueue.size > 0) {
            processEventQueue();
        }
    }
}

async function initializeApp() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, provider);

        // Set up event listeners
        document.getElementById('connect-wallet').addEventListener('click', connectWallet);

        // Initial word loading with animation
        await loadAllWords();

        // Set up contract event listener
        setupEventListener();

        // Listen for network changes
        if (window.ethereum) {
            window.ethereum.on('chainChanged', () => {
                window.location.reload();
            });
        }
    } catch (error) {
        showStatus(`Initialization error: ${error.message}`, 'error');
    }
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
        const wordPromises = [];
        for (let i = 0; i < 128; i++) {
            wordPromises.push(getWordWithAuthorInfo(i));
        }

        cachedWords = await Promise.all(wordPromises);
        await updateWordsDisplay();
    } catch (error) {
        showStatus(`Error loading words: ${error.message}`, 'error');
    } finally {
        stopLoadingAnimation();
    }
}

async function updateSingleWord(index) {
    try {
        cachedWords[index] = await getWordWithAuthorInfo(index);
        await updateWordsDisplay();
    } catch (error) {
        showStatus(`Error updating word ${index}: ${error.message}`, 'error');
    }
}

async function updateWordsDisplay() {
    const wordsContainer = document.getElementById('words-display');
    wordsContainer.innerHTML = '';

    // Display words as a continuous sentence
    cachedWords.forEach((wordInfo, index) => {
        if (index > 0) {
            // Add space before words (except the first one)
            wordsContainer.appendChild(document.createTextNode(' '));
        }

        const wordSpan = document.createElement('span');
        wordSpan.className = 'word';
        wordSpan.textContent = wordInfo.word;
        wordSpan.dataset.tribe = wordInfo.tribe;
        wordSpan.dataset.index = index;
        wordSpan.dataset.author = wordInfo.authorName || wordInfo.authorAddress;

        wordSpan.onclick = () => showWordPopup(index, wordInfo);

        wordsContainer.appendChild(wordSpan);
    });
}

function showWordPopup(wordIndex, wordInfo) {
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

    // Set up event listeners
    popup.addEventListener('click', (e) => {
        if (e.target === popup) {
            popup.remove();
        }
    });

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
            const tx = await contract.contribute(wordIndex, newWord);

            // Close popup as soon as transaction is sent
            popup.remove();
            showStatus('Transaction sent! Waiting for confirmation...', 'success');

            // Wait for transaction confirmation
            await tx.wait();
            showStatus('Word contributed successfully!', 'success');
            await updateSingleWord(wordIndex);

        } catch (error) {
            showStatus(`Error: ${error.message}`, 'error');
        } finally {
            setLoading(false);
        }
    });

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            button.click();
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
        let tribe = '0'; // default tribe

        // Try to get author's registered name and tribe
        if (author !== ethers.constants.AddressZero) {
            try {
                const user = await contract.users(author);
                authorName = user.name;
                tribe = user.tribe.toString();
            } catch (error) {
                console.warn(`Couldn't fetch user info for ${author}`);
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
        return {
            word: '[...]',
            authorAddress: 'unknown',
            authorName: '',
            tribe: '0'
        };
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
    statusElement.textContent = message;
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

