import http from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';

const DEFAULT_PASSWORD = 'money';
const ADMIN_PASSWORD = process.env.DOSH_ADMIN_PASSWORD || 'moneymoney.';
const DEFAULT_TAB_NAME = 'Pod Kotlem';
const DEFAULT_CURRENCY = 'Kč';
const DEFAULT_PORT = 3000;
const OPEN_STATE = 1;
const ADMIN_TAB_ID = '__admin__';
const DEFAULT_TAB_ID = 'default';

const port = Number(process.env.PORT || DEFAULT_PORT);
const universalPassword = process.env.DOSH_PASSWORD || DEFAULT_PASSWORD;
const corsOrigin = process.env.CORS_ORIGIN || '*';
const TOKEN_SECRET = process.env.DOSH_TOKEN_SECRET || 'dosh-demo-token-secret';
const DATABASE_URL = process.env.DATABASE_URL || '';
const rawTokenTtlMs = Number(process.env.DOSH_TOKEN_TTL_MS ?? '0');
const TOKEN_TTL_MS = Number.isFinite(rawTokenTtlMs) && rawTokenTtlMs > 0 ? rawTokenTtlMs : 0;

const tabs = new Map();
const clients = new Map(); // key: `${tabId}:${clientId}`
const socketByClientKey = new Map(); // key: `${tabId}:${clientId}`
let dbPool = null;

tabs.set(DEFAULT_TAB_ID, createTabRecord(DEFAULT_TAB_ID, DEFAULT_TAB_NAME, universalPassword, DEFAULT_CURRENCY));

const server = http.createServer(async (req, res) => {
  if (applyCors(req, res)) {
    return;
  }

  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (method === 'GET' && url.pathname === '/') {
    writeJson(res, 200, {
      service: 'dosh-backend',
      status: 'running',
      realtime: true
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/health') {
    const totalExpenses = Array.from(tabs.values()).reduce((sum, tab) => sum + tab.expenses.length, 0);
    const totalPeople = Array.from(tabs.values()).reduce((sum, tab) => sum + tab.people.size, 0);
    writeJson(res, 200, {
      ok: true,
      tabs: tabs.size,
      people: totalPeople,
      expenses: totalExpenses
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth') {
    const body = await parseJsonBody(req);
    if (!body || typeof body.password !== 'string' || typeof body.clientId !== 'string') {
      writeJson(res, 400, { ok: false, error: 'password and clientId are required' });
      return;
    }

    const clientId = sanitizeClientId(body.clientId);
    if (!clientId) {
      writeJson(res, 400, { ok: false, error: 'clientId is required' });
      return;
    }

    if (body.password === ADMIN_PASSWORD) {
      const token = createSessionToken({ clientId, tabId: ADMIN_TAB_ID, isAdmin: true });
      writeJson(res, 200, {
        ok: true,
        token,
        session: {
          clientId,
          username: null,
          connected: false,
          lastSeenAtMs: Date.now(),
          isAdmin: true,
          tabId: ADMIN_TAB_ID,
          tabName: 'Tab Admin',
          tabCurrency: null
        }
      });
      return;
    }

    const tab = findTabByPassword(body.password);
    if (!tab) {
      writeJson(res, 401, { ok: false, error: 'invalid password' });
      return;
    }

    const session = getOrCreateClient(tab.id, clientId);
    const token = createSessionToken({ clientId, tabId: tab.id, isAdmin: false });

    writeJson(res, 200, {
      ok: true,
      token,
      session: {
        ...serializeClient(session),
        isAdmin: false,
        tabId: tab.id,
        tabName: tab.name,
        tabCurrency: tab.currency
      }
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/session') {
    const token = url.searchParams.get('token') || '';
    const clientId = sanitizeClientId(url.searchParams.get('clientId') || '');

    if (!clientId) {
      writeJson(res, 400, { ok: false, error: 'clientId is required' });
      return;
    }

    const sessionToken = parseAndVerifyToken(token, clientId);
    if (!sessionToken) {
      writeJson(res, 401, { ok: false, error: 'invalid session' });
      return;
    }

    if (sessionToken.isAdmin) {
      writeJson(res, 200, {
        ok: true,
        session: {
          clientId,
          username: null,
          connected: false,
          lastSeenAtMs: Date.now(),
          isAdmin: true,
          tabId: ADMIN_TAB_ID,
          tabName: 'Tab Admin',
          tabCurrency: null
        }
      });
      return;
    }

    const tab = tabs.get(sessionToken.tabId);
    if (!tab) {
      writeJson(res, 401, { ok: false, error: 'tab no longer exists' });
      return;
    }

    const session = getOrCreateClient(tab.id, clientId);
    writeJson(res, 200, {
      ok: true,
      session: {
        ...serializeClient(session),
        isAdmin: false,
        tabId: tab.id,
        tabName: tab.name,
        tabCurrency: tab.currency
      }
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/tabs') {
    const token = url.searchParams.get('token') || '';
    const admin = requireAdminSession(token);
    if (!admin.ok) {
      writeJson(res, 401, { ok: false, error: admin.error });
      return;
    }

    writeJson(res, 200, {
      ok: true,
      tabs: Array.from(tabs.values())
        .map((tab) => ({
          id: tab.id,
          name: tab.name,
          currency: tab.currency,
          people: tab.people.size,
          expenses: tab.expenses.length
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/tabs') {
    const body = await parseJsonBody(req);
    if (!body || typeof body.token !== 'string') {
      writeJson(res, 400, { ok: false, error: 'token is required' });
      return;
    }

    const admin = requireAdminSession(body.token);
    if (!admin.ok) {
      writeJson(res, 401, { ok: false, error: admin.error });
      return;
    }

    const name = normalizeTabName(body.name || '');
    const password = normalizeTabPassword(body.password || '');
    const currency = normalizeCurrency(body.currency || '');

    if (!name) {
      writeJson(res, 400, { ok: false, error: 'tab name must be 1-40 characters' });
      return;
    }

    if (!password) {
      writeJson(res, 400, { ok: false, error: 'tab password must be 1-80 characters' });
      return;
    }

    if (!currency) {
      writeJson(res, 400, { ok: false, error: 'currency must be 1-5 characters' });
      return;
    }

    if (password === ADMIN_PASSWORD) {
      writeJson(res, 400, { ok: false, error: 'tab password cannot be admin password' });
      return;
    }

    if (findTabByPassword(password)) {
      writeJson(res, 409, { ok: false, error: 'tab password already exists' });
      return;
    }

    const tabId = `tab-${randomUUID().slice(0, 8)}`;
    const tab = createTabRecord(tabId, name, password, currency);
    tabs.set(tab.id, tab);
    await persistState();

    writeJson(res, 201, { ok: true, tab: { id: tab.id, name: tab.name, currency: tab.currency } });
    return;
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/tabs/')) {
    const token = url.searchParams.get('token') || '';
    const admin = requireAdminSession(token);
    if (!admin.ok) {
      writeJson(res, 401, { ok: false, error: admin.error });
      return;
    }

    const tabId = decodeURIComponent(url.pathname.slice('/api/tabs/'.length));
    if (!tabId || !tabs.has(tabId)) {
      writeJson(res, 404, { ok: false, error: 'tab not found' });
      return;
    }

    tabs.delete(tabId);
    cleanupTabConnections(tabId);
    await persistState();

    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: 'Not found' });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const requestedClientId = sanitizeClientId(url.searchParams.get('clientId') || '');
  const sessionToken = parseAndVerifyToken(token, requestedClientId);

  if (!sessionToken || sessionToken.isAdmin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!tabs.has(sessionToken.tabId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, {
      tabId: sessionToken.tabId,
      clientId: requestedClientId
    });
  });
});

wss.on('connection', (ws, session) => {
  const tab = tabs.get(session.tabId);
  if (!tab) {
    ws.close(4004, 'tab not found');
    return;
  }

  const client = getOrCreateClient(session.tabId, session.clientId);
  const clientKey = makeClientKey(session.tabId, session.clientId);

  client.connected = true;
  client.lastSeenAtMs = Date.now();

  const existingSocket = socketByClientKey.get(clientKey);
  if (existingSocket && existingSocket !== ws && existingSocket.readyState === OPEN_STATE) {
    existingSocket.close(4009, 'superseded by newer connection');
  }

  socketByClientKey.set(clientKey, ws);

  sendState(ws, session.tabId, session.clientId);
  broadcastState(session.tabId);

  ws.on('message', async (raw) => {
    const message = parseWsMessage(raw);
    if (!message || typeof message.type !== 'string') {
      sendError(ws, 'invalid message format');
      return;
    }

    try {

    if (message.type === 'set_username') {
      if (typeof message.username !== 'string') {
        sendError(ws, 'username must be a string');
        return;
      }

      const normalized = normalizeUsername(message.username);
      if (!normalized) {
        sendError(ws, 'username must be 2-24 characters');
        return;
      }

      client.username = normalized;
      client.lastSeenAtMs = Date.now();
      broadcastState(session.tabId);
      return;
    }

    if (message.type === 'add_person') {
      const name = normalizeName(message.name || '');
      if (!name) {
        sendError(ws, 'person name must be 1-24 characters');
        return;
      }

      tab.people.add(resolveCanonicalPersonName(tab, name));
      client.lastSeenAtMs = Date.now();
      await persistState();
      broadcastState(session.tabId);
      return;
    }

    if (message.type === 'remove_person') {
      const name = normalizeName(message.name || '');
      if (!name) {
        sendError(ws, 'person name is invalid');
        return;
      }

      const canonicalName = resolveNameInCollection(tab.people, name);
      if (canonicalName) {
        tab.people.delete(canonicalName);
      }
      client.lastSeenAtMs = Date.now();
      await persistState();
      broadcastState(session.tabId);
      return;
    }

    if (message.type === 'add_expense') {
      const validation = validateExpenseInput(message, tab);
      if (!validation.ok) {
        sendError(ws, validation.error);
        return;
      }

      tab.expenses.push({
        id: randomUUID(),
        createdAtMs: Date.now(),
        description: validation.description,
        amountCents: validation.amountCents,
        paidByName: validation.paidByName,
        splits: validation.splits,
        createdByClientId: client.clientId
      });

      client.lastSeenAtMs = Date.now();
      await persistState();
      broadcastState(session.tabId);
      return;
    }

    if (message.type === 'remove_expense') {
      const id = String(message.id || '').trim();
      if (!id) {
        sendError(ws, 'expense id is required');
        return;
      }

      const index = tab.expenses.findIndex((expense) => expense.id === id);
      if (index === -1) {
        sendError(ws, 'expense not found');
        return;
      }

      tab.expenses.splice(index, 1);
      client.lastSeenAtMs = Date.now();
      await persistState();
      broadcastState(session.tabId);
      return;
    }

    if (message.type === 'ping') {
      safeSend(ws, {
        type: 'pong',
        serverNowMs: Date.now()
      });
      return;
    }

    sendError(ws, 'unsupported message type');
    } catch (error) {
      sendError(ws, 'internal error');
    }
  });

  ws.on('close', () => {
    if (socketByClientKey.get(clientKey) === ws) {
      socketByClientKey.delete(clientKey);
    }

    const existing = clients.get(clientKey);
    if (existing) {
      existing.connected = false;
      existing.lastSeenAtMs = Date.now();
    }

    broadcastState(session.tabId);
  });

  ws.on('error', () => {
    // ignore; close handler updates state
  });
});

await initStorage();

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`dosh backend listening on http://localhost:${port}`);
});

function createTabRecord(id, name, password, currency = DEFAULT_CURRENCY) {
  return {
    id,
    name,
    password,
    currency,
    people: new Set(),
    expenses: []
  };
}

function findTabByPassword(password) {
  const normalized = String(password || '');
  for (const tab of tabs.values()) {
    if (tab.password === normalized) {
      return tab;
    }
  }
  return null;
}

function requireAdminSession(token) {
  const payload = parseAndVerifyToken(token, null);
  if (!payload) {
    return { ok: false, error: 'invalid admin session' };
  }
  if (!payload.isAdmin) {
    return { ok: false, error: 'admin session required' };
  }
  return { ok: true, payload };
}

function cleanupTabConnections(tabId) {
  for (const [clientKey, ws] of socketByClientKey.entries()) {
    if (!clientKey.startsWith(`${tabId}:`)) {
      continue;
    }

    if (ws.readyState === OPEN_STATE) {
      ws.close(4008, 'tab deleted');
    }

    socketByClientKey.delete(clientKey);
  }

  for (const clientKey of clients.keys()) {
    if (clientKey.startsWith(`${tabId}:`)) {
      clients.delete(clientKey);
    }
  }
}

async function initStorage() {
  if (!DATABASE_URL) {
    return;
  }

  dbPool = new Pool({
    connectionString: DATABASE_URL
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await dbPool.query('SELECT data FROM app_state WHERE id = 1');
  if (result.rows.length > 0) {
    hydrateState(result.rows[0].data);
  }

  if (!tabs.has(DEFAULT_TAB_ID)) {
    tabs.set(DEFAULT_TAB_ID, createTabRecord(DEFAULT_TAB_ID, DEFAULT_TAB_NAME, universalPassword, DEFAULT_CURRENCY));
  } else {
    const defaultTab = tabs.get(DEFAULT_TAB_ID);
    if (defaultTab.name === 'Default tab') {
      defaultTab.name = DEFAULT_TAB_NAME;
    }
    if (!defaultTab.currency) {
      defaultTab.currency = DEFAULT_CURRENCY;
    }
  }

  await persistState();
}

function serializeState() {
  return {
    tabs: Array.from(tabs.values()).map((tab) => ({
      id: tab.id,
      name: tab.name,
      password: tab.password,
      currency: tab.currency,
      people: Array.from(tab.people),
      expenses: tab.expenses
    }))
  };
}

function hydrateState(data) {
  if (!data || !Array.isArray(data.tabs)) {
    return;
  }

  tabs.clear();

  for (const tab of data.tabs) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.name !== 'string' || typeof tab.password !== 'string') {
      continue;
    }

    const record = createTabRecord(tab.id, tab.name, tab.password, normalizeCurrency(tab.currency || '') || DEFAULT_CURRENCY);

    if (Array.isArray(tab.people)) {
      for (const name of tab.people) {
        const normalized = normalizeName(name);
        if (normalized) {
          record.people.add(normalized);
        }
      }
    }

    if (Array.isArray(tab.expenses)) {
      for (const expense of tab.expenses) {
        if (!expense || typeof expense.id !== 'string' || !Array.isArray(expense.splits)) {
          continue;
        }

        record.expenses.push({
          id: expense.id,
          createdAtMs: Number(expense.createdAtMs) || Date.now(),
          description: String(expense.description || ''),
          amountCents: Number(expense.amountCents) || 0,
          paidByName: String(expense.paidByName || ''),
          splits: expense.splits
            .map((split) => ({
              participantName: String(split?.participantName || ''),
              weight: Number(split?.weight) || 0
            }))
            .filter((split) => split.participantName && split.weight > 0),
          createdByClientId: String(expense.createdByClientId || '')
        });
      }
    }

    tabs.set(record.id, record);
  }
}

async function persistState() {
  if (!dbPool) {
    return;
  }

  const data = JSON.stringify(serializeState());
  await dbPool.query(
    `
      INSERT INTO app_state (id, data, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [data]
  );
}

function validateExpenseInput(message, tab) {
  if (typeof message.description !== 'string') {
    return { ok: false, error: 'description is required' };
  }

  const description = normalizeDescription(message.description);
  if (!description) {
    return { ok: false, error: 'description must be 2-80 characters' };
  }

  const amountValue = Number(message.amount);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return { ok: false, error: 'amount must be a positive number' };
  }

  const amountCents = Math.round(amountValue * 100);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'amount is invalid' };
  }

  const paidByNameRaw = normalizeName(message.paidByName || '');
  if (!paidByNameRaw) {
    return { ok: false, error: 'payer name is required' };
  }

  const paidByName = resolveNameInCollection(tab.people, paidByNameRaw);

  if (!tab.people.has(paidByName)) {
    return { ok: false, error: 'payer must be selected from people list' };
  }

  if (!Array.isArray(message.splits) || message.splits.length === 0) {
    return { ok: false, error: 'select at least one participant in "for whom"' };
  }

  const dedup = new Set();
  const splits = [];

  for (const rawSplit of message.splits) {
    const participantNameRaw = normalizeName(rawSplit?.participantName || '');
    const weight = Number(rawSplit?.weight);

    if (!participantNameRaw) {
      return { ok: false, error: 'split participant name is invalid' };
    }

    const participantName = resolveNameInCollection(tab.people, participantNameRaw);

    if (dedup.has(participantName)) {
      return { ok: false, error: 'split participants must be unique' };
    }

    if (!tab.people.has(participantName)) {
      return { ok: false, error: 'all split participants must come from people list' };
    }

    if (!Number.isFinite(weight) || weight <= 0) {
      return { ok: false, error: 'all split weights must be positive' };
    }

    const roundedWeight = Math.round(weight * 1000) / 1000;
    if (roundedWeight <= 0) {
      return { ok: false, error: 'all split weights must be positive' };
    }

    dedup.add(participantName);
    splits.push({ participantName, weight: roundedWeight });
  }

  if (splits.length === 0) {
    return { ok: false, error: 'at least one split participant is required' };
  }

  if (description.startsWith('PAY:')) {
    if (splits.length !== 1) {
      return { ok: false, error: 'payment must target exactly one person' };
    }

    if (splits[0].participantName === paidByName) {
      return { ok: false, error: 'payment must be between two different people' };
    }
  }

  return {
    ok: true,
    description,
    amountCents,
    paidByName,
    splits
  };
}

function computeLedger(tab) {
  const nameSet = new Set(tab.people);

  const balanceMap = new Map();
  for (const name of nameSet) {
    balanceMap.set(name, 0);
  }

  const normalizedExpenses = tab.expenses.map((expense) => {
    const allocations = allocateByWeights(expense.amountCents, expense.splits);

    if (nameSet.has(expense.paidByName)) {
      balanceMap.set(expense.paidByName, (balanceMap.get(expense.paidByName) || 0) + expense.amountCents);
    }

    for (const split of allocations) {
      if (nameSet.has(split.participantName)) {
        balanceMap.set(split.participantName, (balanceMap.get(split.participantName) || 0) - split.shareCents);
      }
    }

    return {
      id: expense.id,
      description: expense.description,
      amountCents: expense.amountCents,
      paidByName: expense.paidByName,
      createdAtMs: expense.createdAtMs,
      splits: allocations
    };
  });

  const balances = Array.from(balanceMap.entries())
    .map(([name, netCents]) => ({ name, netCents }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const settlements = computeSettlements(balances);
  const knownNames = Array.from(nameSet).sort();

  return {
    people: Array.from(tab.people).sort(),
    knownNames,
    balances,
    settlements,
    expenses: normalizedExpenses
  };
}

function allocateByWeights(amountCents, splits) {
  const totalWeight = splits.reduce((sum, split) => sum + split.weight, 0);
  if (totalWeight <= 0) {
    return splits.map((split) => ({
      participantName: split.participantName,
      weight: split.weight,
      shareCents: 0
    }));
  }

  const provisional = splits.map((split, index) => {
    const exactShare = (amountCents * split.weight) / totalWeight;
    const baseShare = Math.floor(exactShare);
    return {
      index,
      participantName: split.participantName,
      weight: split.weight,
      baseShare,
      remainder: exactShare - baseShare
    };
  });

  let assigned = provisional.reduce((sum, row) => sum + row.baseShare, 0);
  let remaining = amountCents - assigned;

  provisional.sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder - a.remainder;
    }

    return a.participantName.localeCompare(b.participantName);
  });

  let cursor = 0;
  while (remaining > 0 && provisional.length > 0) {
    provisional[cursor].baseShare += 1;
    remaining -= 1;
    cursor = (cursor + 1) % provisional.length;
  }

  provisional.sort((a, b) => a.index - b.index);

  return provisional.map((row) => ({
    participantName: row.participantName,
    weight: row.weight,
    shareCents: row.baseShare
  }));
}

function computeSettlements(balances) {
  const creditors = balances
    .filter((balance) => balance.netCents > 0)
    .map((balance) => ({ name: balance.name, amountCents: balance.netCents }))
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));

  const debtors = balances
    .filter((balance) => balance.netCents < 0)
    .map((balance) => ({ name: balance.name, amountCents: Math.abs(balance.netCents) }))
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));

  const transfers = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amountCents = Math.min(creditor.amountCents, debtor.amountCents);

    if (amountCents > 0) {
      transfers.push({
        fromName: debtor.name,
        toName: creditor.name,
        amountCents
      });
    }

    creditor.amountCents -= amountCents;
    debtor.amountCents -= amountCents;

    if (creditor.amountCents === 0) {
      creditorIndex += 1;
    }

    if (debtor.amountCents === 0) {
      debtorIndex += 1;
    }
  }

  return transfers;
}

function buildSnapshot(tabId, forClientId) {
  const tab = tabs.get(tabId);
  if (!tab) {
    throw new Error('tab not found');
  }

  const self = getOrCreateClient(tabId, forClientId);
  const ledger = computeLedger(tab);

  return {
    serverNowMs: Date.now(),
    tabId: tab.id,
    tabName: tab.name,
    currency: tab.currency,
    people: ledger.people,
    knownNames: ledger.knownNames,
    expenses: ledger.expenses,
    balances: ledger.balances,
    settlements: ledger.settlements,
    clients: Array.from(clients.values())
      .filter((client) => client.tabId === tabId)
      .map(serializeClient)
      .sort((a, b) => a.clientId.localeCompare(b.clientId)),
    self: serializeClient(self)
  };
}

function sendState(ws, tabId, clientId) {
  safeSend(ws, {
    type: 'state',
    snapshot: buildSnapshot(tabId, clientId)
  });
}

function broadcastState(tabId) {
  for (const [clientKey, ws] of socketByClientKey.entries()) {
    if (ws.readyState !== OPEN_STATE) {
      continue;
    }

    const [entryTabId, clientId] = splitClientKey(clientKey);
    if (entryTabId !== tabId) {
      continue;
    }

    sendState(ws, tabId, clientId);
  }
}

function makeClientKey(tabId, clientId) {
  return `${tabId}:${clientId}`;
}

function splitClientKey(clientKey) {
  const separatorIndex = clientKey.indexOf(':');
  return [clientKey.slice(0, separatorIndex), clientKey.slice(separatorIndex + 1)];
}

function getOrCreateClient(tabId, clientId) {
  const sanitizedTabId = String(tabId || '').trim();
  const sanitizedClientId = sanitizeClientId(clientId);
  if (!sanitizedTabId || !sanitizedClientId) {
    throw new Error('invalid client key');
  }

  const key = makeClientKey(sanitizedTabId, sanitizedClientId);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const client = {
    tabId: sanitizedTabId,
    clientId: sanitizedClientId,
    username: null,
    connected: false,
    lastSeenAtMs: Date.now()
  };

  clients.set(key, client);
  return client;
}

function serializeClient(client) {
  return {
    clientId: client.clientId,
    username: client.username,
    connected: client.connected,
    lastSeenAtMs: client.lastSeenAtMs
  };
}

function createSessionToken(payload) {
  const normalizedPayload = {
    clientId: sanitizeClientId(payload.clientId),
    tabId: String(payload.tabId || '').trim(),
    isAdmin: Boolean(payload.isAdmin),
    createdAtMs: Date.now()
  };

  if (!normalizedPayload.clientId || !normalizedPayload.tabId) {
    throw new Error('invalid token payload');
  }

  const encoded = Buffer.from(JSON.stringify(normalizedPayload), 'utf8').toString('base64url');
  const signature = createSignature(encoded);

  return `${encoded}.${signature}`;
}

function createSignature(encodedPayload) {
  return createHmac('sha256', TOKEN_SECRET).update(encodedPayload).digest('base64url');
}

function parseAndVerifyToken(token, expectedClientId) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  let expectedSignature;
  try {
    expectedSignature = createSignature(encodedPayload);
  } catch {
    return null;
  }

  let signatureBuffer;
  let expectedBuffer;
  try {
    signatureBuffer = Buffer.from(signature, 'base64url');
    expectedBuffer = Buffer.from(expectedSignature, 'base64url');
  } catch {
    return null;
  }

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let payload;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  const clientId = sanitizeClientId(payload.clientId || '');
  const tabId = String(payload.tabId || '').trim();
  const isAdmin = Boolean(payload.isAdmin);
  const createdAtMs = Number(payload.createdAtMs);

  if (!clientId || !tabId || !Number.isFinite(createdAtMs)) {
    return null;
  }

  if (expectedClientId != null) {
    const normalizedExpectedClientId = sanitizeClientId(expectedClientId);
    if (clientId !== normalizedExpectedClientId) {
      return null;
    }
  }

  if (TOKEN_TTL_MS > 0 && createdAtMs + TOKEN_TTL_MS < Date.now()) {
    return null;
  }

  return { clientId, tabId, isAdmin, createdAtMs };
}

function parseWsMessage(raw) {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeSend(ws, payload) {
  if (ws.readyState !== OPEN_STATE) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  safeSend(ws, {
    type: 'error',
    message
  });
}

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }

      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value);
      } catch {
        resolve(null);
      }
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

function sanitizeClientId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  return normalized.slice(0, 120);
}

function normalizeUsername(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 24) {
    return null;
  }

  return normalized;
}

function normalizeName(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 24) {
    return null;
  }

  return normalized;
}

function normalizeNameKey(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function resolveNameInCollection(names, name) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return null;
  }

  const targetKey = normalizeNameKey(normalizedName);
  for (const existingName of names) {
    if (normalizeNameKey(existingName) === targetKey) {
      return existingName;
    }
  }

  return null;
}

function resolveCanonicalPersonName(tab, name) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return null;
  }

  const fromPeople = resolveNameInCollection(tab.people, normalizedName);
  if (fromPeople) {
    return fromPeople;
  }

  const targetKey = normalizeNameKey(normalizedName);
  for (const expense of tab.expenses) {
    if (normalizeNameKey(expense.paidByName) === targetKey) {
      return expense.paidByName;
    }

    for (const split of expense.splits) {
      if (normalizeNameKey(split.participantName) === targetKey) {
        return split.participantName;
      }
    }
  }

  return normalizedName;
}

function normalizeTabName(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 40) {
    return null;
  }

  return normalized;
}

function normalizeTabPassword(value) {
  const normalized = String(value || '').trim();
  if (normalized.length < 1 || normalized.length > 80) {
    return null;
  }

  return normalized;
}

function normalizeCurrency(value) {
  const normalized = String(value || '').trim();
  if (normalized.length < 1 || normalized.length > 5) {
    return null;
  }

  return normalized;
}

function normalizeDescription(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 80) {
    return null;
  }

  return normalized;
}
