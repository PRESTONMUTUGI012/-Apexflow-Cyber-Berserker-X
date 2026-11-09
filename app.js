let ws = null;
let currentSymbol = null;
let tickHistory = [];
let lastQuote = null;
let isAuthenticated = false;
let pendingContractType = null;

document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    const marketSelectEl = document.getElementById('marketSelect');
    if (marketSelectEl) {
        marketSelectEl.addEventListener('change', onSymbolChange);
    }
});

// Step 1 & 3: Connect to WebSocket Stream
function initWebSocket() {
    const appId = document.getElementById('appIdInput')?.value || '1089';
    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    
    if (ws) ws.close();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        updateConnectionStatus(true, 'Connected');
        ws.send(JSON.stringify({ "active_symbols": "full" }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };

    ws.onclose = () => {
        updateConnectionStatus(false, 'Disconnected (Reconnecting...)');
        setTimeout(initWebSocket, 4000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        updateConnectionStatus(false, 'Connection Error');
    };
}

// Step 1 & 2: Authorize Account
function authorizeAccount() {
    const token = document.getElementById('apiTokenInput').value.trim();
    if (!token) {
        alert('Please enter your Personal Access Token (PAT)');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ authorize: token }));
        updateProposalStatus('Authorizing session...');
    }
}

// Handler for all Deriv API WebSocket Messages (Steps 1 through 6)
function handleMessage(data) {
    // Step 2: Handle Authorize Response
    if (data.msg_type === 'authorize') {
        if (data.error) {
            isAuthenticated = false;
            document.getElementById('authBadge').innerText = 'Auth Error';
            document.getElementById('authBadge').className = 'text-[10px] px-2 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-500/30';
            updateProposalStatus(`Auth Failed: ${data.error.message}`);
        } else {
            isAuthenticated = true;
            const accountId = data.authorize.loginid;
            document.getElementById('authBadge').innerText = `Authorized (${accountId})`;
            document.getElementById('authBadge').className = 'text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-500/30';
            updateProposalStatus(`Authorized account ${accountId}. Ready to trade.`);
        }
    }

    // Active Symbols Populator
    if (Array.isArray(data.active_symbols)) {
        const marketSelect = document.getElementById('marketSelect');
        if (marketSelect) {
            marketSelect.innerHTML = "";
            data.active_symbols.forEach(market => {
                const symbol = market.underlying_symbol;
                const name = market.display_name || market.market_display_name || market.submarket_display_name || symbol;
                if (!symbol) return;
                const option = document.createElement("option");
                option.value = symbol;
                option.textContent = name + " (" + symbol + ")";
                marketSelect.appendChild(option);
            });

            if (data.active_symbols.length > 0 && !currentSymbol) {
                currentSymbol = data.active_symbols[0].underlying_symbol;
                if (currentSymbol) {
                    marketSelect.value = currentSymbol;
                    subscribeToSymbolTicks(currentSymbol);
                }
            }
        }
    }

    // Live Ticks Processing
    if (data.tick) {
        const priceElement = document.getElementById('price');
        const timeElement = document.getElementById('time');

        const rawQuote = data.tick.quote;
        const epoch = data.tick.epoch;
        const quote = parseFloat(rawQuote).toFixed(data.tick.pip_size || 4);
        const formattedTime = new Date(epoch * 1000).toLocaleTimeString();

        if (priceElement) priceElement.textContent = quote;
        if (timeElement) timeElement.textContent = formattedTime;

        const currentNum = parseFloat(quote);
        lastQuote = quote;

        tickHistory.push(currentNum);
        if (tickHistory.length > 30) tickHistory.shift();

        renderSVGChart();
        appendTickTableRow(formattedTime, quote);
    }

    // Step 4: Proposal Response -> Execute Buy
    if (data.msg_type === 'proposal') {
        if (data.error) {
            updateProposalStatus(`Proposal Error: ${data.error.message}`);
        } else if (data.proposal) {
            const proposalId = data.proposal.id;
            const price = data.proposal.ask_price;
            updateProposalStatus(`Proposal received (ID: ${proposalId}). Purchasing contract...`);
            
            // Step 5: Send Buy Request using proposal ID
            ws.send(JSON.stringify({
                buy: proposalId,
                price: price
            }));
        }
    }

    // Step 5: Buy Response -> Subscribe to Open Contract
    if (data.msg_type === 'buy') {
        if (data.error) {
            updateProposalStatus(`Buy Order Failed: ${data.error.message}`);
        } else if (data.buy) {
            const contractId = data.buy.contract_id;
            const purchasePrice = data.buy.buy_price;
            updateProposalStatus(`Contract #${contractId} Purchased for $${purchasePrice}!`);
            
            // Step 6: Subscribe to Track Contract Status
            ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            }));
        }
    }

    // Step 6: Proposal Open Contract Live Tracking Response
    if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
        renderOpenContractTracker(data.proposal_open_contract);
    }
}

// Step 4: Request Proposal and Trigger Buy Flow
function requestProposalAndBuy(contractType) {
    if (!isAuthenticated) {
        alert('Please authorize your Personal Access Token first (Step 1 & 2).');
        return;
    }
    if (!currentSymbol) {
        alert('Please select an active market symbol first.');
        return;
    }

    const stake = parseFloat(document.getElementById('stakeInput').value) || 10;
    const duration = parseInt(document.getElementById('durationInput').value, 10) || 5;

    updateProposalStatus(`Requesting ${contractType} proposal for ${currentSymbol}...`);

    ws.send(JSON.stringify({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: duration,
        duration_unit: 't',
        symbol: currentSymbol
    }));
}

// Step 6: Render Open Contract Status UI
function renderOpenContractTracker(poc) {
    const box = document.getElementById('activeContractBox');
    if (!box) return;

    const status = poc.is_sold ? (poc.status === 'won' ? 'WON 🎉' : 'LOST ❌') : 'RUNNING ⏳';
    const profit = parseFloat(poc.profit || 0).toFixed(2);
    const profitColor = profit >= 0 ? 'text-emerald-400' : 'text-rose-400';

    box.innerHTML = `
        <div class="flex justify-between items-center font-bold">
            <span>Contract #${poc.contract_id}</span>
            <span class="${profitColor}">${status}</span>
        </div>
        <div class="text-[11px] text-slate-300">Symbol: ${poc.underlying}</div>
        <div class="text-[11px] text-slate-300">Buy Price: $${poc.buy_price}</div>
        <div class="text-[11px] font-bold ${profitColor}">Profit/Loss: $${profit}</div>
    `;
}

// Market Change Helper
function onSymbolChange() {
    const select = document.getElementById('marketSelect');
    if (select) {
        currentSymbol = select.value;
        subscribeToSymbolTicks(currentSymbol);
    }
}

function subscribeToSymbolTicks(symbol) {
    if (ws && ws.readyState === WebSocket.OPEN && symbol) {
        ws.send(JSON.stringify({ forget_all: 'ticks' }));
        tickHistory = [];
        lastQuote = null;
        ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        const chartSymbolEl = document.getElementById('chartSymbol');
        if (chartSymbolEl) chartSymbolEl.innerText = symbol;
    }
}

// Chart SVG Renderer
function renderSVGChart() {
    if (tickHistory.length < 2) return;
    const svg = document.getElementById('tickChart');
    const path = document.getElementById('chartPath');
    if (!svg || !path) return;

    const width = svg.clientWidth;
    const height = svg.clientHeight;
    const min = Math.min(...tickHistory);
    const max = Math.max(...tickHistory);
    const range = (max - min) || 1;

    const points = tickHistory.map((val, idx) => {
        const x = (idx / (tickHistory.length - 1)) * width;
        const y = height - ((val - min) / range) * (height - 20) - 10;
        return `${x},${y}`;
    });

    path.setAttribute('d', `M ${points.join(' L ')}`);
}

// Append Row Helper
function appendTickTableRow(timeStr, quote) {
    const tbody = document.getElementById('tickTableBody');
    if (!tbody) return;

    const row = document.createElement('tr');
    row.innerHTML = `
        <td class="p-2.5 text-slate-400">${timeStr}</td>
        <td class="p-2.5 text-emerald-400 font-bold">${quote}</td>
    `;
    tbody.prepend(row);

    if (tbody.children.length > 10) {
        tbody.removeChild(tbody.lastChild);
    }
}

function updateProposalStatus(msg) {
    const statusEl = document.getElementById('proposalStatus');
    if (statusEl) statusEl.innerText = `Status: ${msg}`;
}

function updateConnectionStatus(isConnected, text) {
    const badge = document.getElementById('status');
    if (!badge) return;

    if (isConnected) {
        badge.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-emerald-500 pulse-green"></span><span class="text-emerald-400 font-mono font-semibold">${text}</span>`;
    } else {
        badge.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-rose-500"></span><span class="text-rose-400 font-mono font-semibold">${text}</span>`;
    }
}
