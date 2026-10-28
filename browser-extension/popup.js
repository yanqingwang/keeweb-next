const statusEl = document.getElementById('status');
const connectEl = document.getElementById('connect');
const loginsEl = document.getElementById('logins');
const actionsEl = document.getElementById('actions');
const connectBtn = document.getElementById('connect-btn');
const saveBtn = document.getElementById('save-btn');
const forgetBtn = document.getElementById('forget-btn');

let activeTab = null;

function send(type, extra) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(Object.assign({ type }, extra), (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
                reject(new Error('no response from the extension worker'));
            } else if (response.error) {
                reject(new Error(response.error));
            } else {
                resolve(response.result);
            }
        });
    });
}

function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
}

function showLogins(entries) {
    loginsEl.innerHTML = '';
    if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No logins saved for this page.';
        loginsEl.appendChild(li);
        return;
    }
    for (const entry of entries) {
        const li = document.createElement('li');
        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = entry.name || '(no title)';
        const login = document.createElement('div');
        login.className = 'login muted';
        login.textContent = entry.login;
        meta.append(name, login);
        const button = document.createElement('button');
        button.textContent = 'Fill';
        button.addEventListener('click', async () => {
            try {
                const result = await send('fill', {
                    tabId: activeTab.id,
                    username: entry.login,
                    password: entry.password
                });
                setStatus(
                    result && result.filled ? 'Filled the login form.' : 'No login form on this page.',
                    !(result && result.filled)
                );
            } catch (e) {
                setStatus(e.message, true);
            }
        });
        li.append(meta, button);
        loginsEl.appendChild(li);
    }
}

async function refresh() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
    if (!activeTab) {
        setStatus('No active tab.', true);
        return;
    }
    try {
        const state = await send('status');
        if (!state.associated) {
            setStatus(state.error || 'Not connected to the app.', !!state.error);
            connectEl.classList.remove('hidden');
            actionsEl.classList.add('hidden');
            return;
        }
        connectEl.classList.add('hidden');
        actionsEl.classList.remove('hidden');
        setStatus('Connected.');
        const entries = await send('get-logins', { url: activeTab.url });
        showLogins(entries || []);
    } catch (e) {
        setStatus(e.message, true);
        connectEl.classList.remove('hidden');
    }
}

connectBtn.addEventListener('click', async () => {
    setStatus('Waiting for confirmation in the app…');
    try {
        const result = await send('associate');
        if (!result.associated) {
            throw new Error(result.error || 'association was rejected');
        }
        await refresh();
    } catch (e) {
        setStatus(e.message, true);
    }
});

saveBtn.addEventListener('click', async () => {
    try {
        const credentials = await send('read-credentials', { tabId: activeTab.id });
        if (!credentials || !credentials.found || !credentials.password) {
            setStatus('No password field found on this page.', true);
            return;
        }
        await send('save-login', {
            url: credentials.url || activeTab.url,
            username: credentials.username,
            password: credentials.password
        });
        setStatus('Login saved to the app.');
        await refresh();
    } catch (e) {
        setStatus(e.message, true);
    }
});

forgetBtn.addEventListener('click', async () => {
    await send('forget');
    await refresh();
});

refresh();