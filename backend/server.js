import http from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const DEFAULT_PASSWORD = 'money';
const DEFAULT_PORT = 3000;
const OPEN_STATE = 1;

const port = Number(process.env.PORT || DEFAULT_PORT);
const universalPassword = process.env.DOSH_PASSWORD || DEFAULT_PASSWORD;
const corsOrigin = process.env.CORS_ORIGIN || '*';
const TOKEN_SECRET = process.env.DOSH_TOKEN_SECRET || 'dosh-demo-token-secret';
const rawTokenTtlMs = Number(process.env.DOSH_TOKEN_TTL_MS ?? '0');
const TOKEN_TTL_MS = Number.isFinite(rawTokenTtlMs) && rawTokenTtlMs > 0 ? rawTokenTtlMs : 0;

const clients = new Map();
const socketByClientId = new Map();
const expenses = [];

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
    writeJson(res, 200, {
      ok: true,
      participants: getParticipants().length,
      expenses: expenses.length
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth') {
    const body = await parseJsonBody(req);
    if (!body || typeof body.password !== 'string' || typeof body.clientId !== 'string') {
      writeJson(res, 400, { ok: false, error: 'password and clientId are required' });
      return;
    }

    if (body.password !== universalPassword) {
      writeJson(res, 401, { ok: false, error: 'invalid password' });
      return;
    }

    const clientId = sanitizeClientId(body.clientId);
    if (!clientId) {
      writeJson(res, 400, { ok: false, error: 'clientId is required' });
      return;
    }

    const session = getOrCreateClient(clientId);
    const token = createSessionToken(clientId);

    writeJson(res, 200, {
      ok: true,
      token,
      session: serializeClient(session)
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

    if (!isTokenValidForClient(token, clientId)) {
      writeJson(res, 401, { ok: false, error: 'invalid session' });
      return;
    }

    const session = getOrCreateClient(clientId);
    writeJson(res, 200, {
      ok: true,
      session: serializeClient(session)
    });
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

  if (!isTokenValidForClient(token, requestedClientId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, requestedClientId);
  });
});

wss.on('connection', (ws, clientId) => {
  const client = getOrCreateClient(clientId);
  client.connected = true;
  client.lastSeenAtMs = Date.now();

  const existingSocket = socketByClientId.get(clientId);
  if (existingSocket && existingSocket !== ws && existingSocket.readyState === OPEN_STATE) {
    existingSocket.close(4009, 'superseded by newer connection');
  }

  socketByClientId.set(clientId, ws);

  sendState(ws, clientId);
  broadcastState();

  ws.on('message', (raw) => {
    const message = parseWsMessage(raw);
    if (!message || typeof message.type !== 'string') {
      sendError(ws, 'invalid message format');
      return;
    }

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
      broadcastState();
      return;
    }

    if (message.type === 'add_expense') {
      const validation = validateExpenseInput(message, client);
      if (!validation.ok) {
        sendError(ws, validation.error);
        return;
      }

      expenses.push({
        id: randomUUID(),
        createdAtMs: Date.now(),
        description: validation.description,
        amountCents: validation.amountCents,
        paidByClientId: validation.paidByClientId,
        splits: validation.splits,
        createdByClientId: client.clientId
      });

      client.lastSeenAtMs = Date.now();
      broadcastState();
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
  });

  ws.on('close', () => {
    if (socketByClientId.get(clientId) === ws) {
      socketByClientId.delete(clientId);
    }

    const existing = clients.get(clientId);
    if (existing) {
      existing.connected = false;
      existing.lastSeenAtMs = Date.now();
    }

    broadcastState();
  });

  ws.on('error', () => {
    // ignore; close handler updates state
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`dosh backend listening on http://localhost:${port}`);
});

function validateExpenseInput(message, self) {
  if (!self.username) {
    return { ok: false, error: 'set your name first' };
  }

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

  const paidByClientId = sanitizeClientId(message.paidByClientId || '');
  if (!paidByClientId) {
    return { ok: false, error: 'payer is required' };
  }

  const payer = clients.get(paidByClientId);
  if (!payer || !payer.username) {
    return { ok: false, error: 'payer must be a named participant' };
  }

  if (!Array.isArray(message.splits) || message.splits.length === 0) {
    return { ok: false, error: 'select at least one participant in "for whom"' };
  }

  const dedup = new Set();
  const splits = [];

  for (const rawSplit of message.splits) {
    const participantClientId = sanitizeClientId(rawSplit?.participantClientId || '');
    const weight = Number(rawSplit?.weight);

    if (!participantClientId) {
      return { ok: false, error: 'split participant is invalid' };
    }

    if (dedup.has(participantClientId)) {
      return { ok: false, error: 'split participants must be unique' };
    }

    const participant = clients.get(participantClientId);
    if (!participant || !participant.username) {
      return { ok: false, error: 'all split participants must be named participants' };
    }

    if (!Number.isFinite(weight) || weight <= 0) {
      return { ok: false, error: 'all split weights must be positive' };
    }

    const roundedWeight = Math.round(weight * 1000) / 1000;
    if (roundedWeight <= 0) {
      return { ok: false, error: 'all split weights must be positive' };
    }

    dedup.add(participantClientId);
    splits.push({ participantClientId, weight: roundedWeight });
  }

  if (splits.length === 0) {
    return { ok: false, error: 'at least one split participant is required' };
  }

  return {
    ok: true,
    description,
    amountCents,
    paidByClientId,
    splits
  };
}

function computeLedger() {
  const participants = getParticipants();
  const balanceMap = new Map(participants.map((p) => [p.clientId, 0]));

  const normalizedExpenses = expenses.map((expense) => {
    const allocations = allocateByWeights(expense.amountCents, expense.splits);

    if (!balanceMap.has(expense.paidByClientId)) {
      return null;
    }

    balanceMap.set(expense.paidByClientId, balanceMap.get(expense.paidByClientId) + expense.amountCents);

    for (const split of allocations) {
      if (!balanceMap.has(split.participantClientId)) {
        continue;
      }

      balanceMap.set(split.participantClientId, balanceMap.get(split.participantClientId) - split.shareCents);
    }

    return {
      id: expense.id,
      description: expense.description,
      amountCents: expense.amountCents,
      paidByClientId: expense.paidByClientId,
      createdAtMs: expense.createdAtMs,
      createdByClientId: expense.createdByClientId,
      splits: allocations
    };
  }).filter(Boolean);

  const balances = participants
    .map((participant) => ({
      participantClientId: participant.clientId,
      username: participant.username,
      netCents: balanceMap.get(participant.clientId) || 0
    }))
    .sort((a, b) => a.username.localeCompare(b.username));

  const settlements = computeSettlements(balances);

  return {
    participants,
    balances,
    settlements,
    expenses: normalizedExpenses
  };
}

function allocateByWeights(amountCents, splits) {
  const totalWeight = splits.reduce((sum, split) => sum + split.weight, 0);
  if (totalWeight <= 0) {
    return splits.map((split) => ({
      participantClientId: split.participantClientId,
      weight: split.weight,
      shareCents: 0
    }));
  }

  const provisional = splits.map((split, index) => {
    const exactShare = (amountCents * split.weight) / totalWeight;
    const baseShare = Math.floor(exactShare);
    return {
      index,
      participantClientId: split.participantClientId,
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

    return a.participantClientId.localeCompare(b.participantClientId);
  });

  let cursor = 0;
  while (remaining > 0 && provisional.length > 0) {
    provisional[cursor].baseShare += 1;
    remaining -= 1;
    cursor = (cursor + 1) % provisional.length;
  }

  provisional.sort((a, b) => a.index - b.index);

  return provisional.map((row) => ({
    participantClientId: row.participantClientId,
    weight: row.weight,
    shareCents: row.baseShare
  }));
}

function computeSettlements(balances) {
  const creditors = balances
    .filter((balance) => balance.netCents > 0)
    .map((balance) => ({
      participantClientId: balance.participantClientId,
      username: balance.username,
      amountCents: balance.netCents
    }))
    .sort((a, b) => b.amountCents - a.amountCents || a.username.localeCompare(b.username));

  const debtors = balances
    .filter((balance) => balance.netCents < 0)
    .map((balance) => ({
      participantClientId: balance.participantClientId,
      username: balance.username,
      amountCents: Math.abs(balance.netCents)
    }))
    .sort((a, b) => b.amountCents - a.amountCents || a.username.localeCompare(b.username));

  const transfers = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amountCents = Math.min(creditor.amountCents, debtor.amountCents);

    if (amountCents > 0) {
      transfers.push({
        fromClientId: debtor.participantClientId,
        fromUsername: debtor.username,
        toClientId: creditor.participantClientId,
        toUsername: creditor.username,
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

function getParticipants() {
  return Array.from(clients.values())
    .filter((client) => Boolean(client.username))
    .map((client) => ({
      clientId: client.clientId,
      username: client.username,
      connected: client.connected
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function buildSnapshot(forClientId) {
  const self = getOrCreateClient(forClientId);
  const ledger = computeLedger();

  return {
    serverNowMs: Date.now(),
    participants: ledger.participants,
    expenses: ledger.expenses,
    balances: ledger.balances,
    settlements: ledger.settlements,
    clients: Array.from(clients.values())
      .map(serializeClient)
      .sort((a, b) => a.clientId.localeCompare(b.clientId)),
    self: serializeClient(self)
  };
}

function sendState(ws, clientId) {
  safeSend(ws, {
    type: 'state',
    snapshot: buildSnapshot(clientId)
  });
}

function broadcastState() {
  for (const [clientId, ws] of socketByClientId.entries()) {
    if (ws.readyState !== OPEN_STATE) {
      continue;
    }

    sendState(ws, clientId);
  }
}

function getOrCreateClient(clientId) {
  const sanitized = sanitizeClientId(clientId);
  if (!sanitized) {
    throw new Error('invalid client id');
  }

  const existing = clients.get(sanitized);
  if (existing) {
    return existing;
  }

  const client = {
    clientId: sanitized,
    username: null,
    connected: false,
    lastSeenAtMs: Date.now()
  };

  clients.set(sanitized, client);
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

function createSessionToken(clientId) {
  const sanitized = sanitizeClientId(clientId);
  if (!sanitized) {
    throw new Error('invalid client id');
  }

  const payload = {
    clientId: sanitized,
    createdAtMs: Date.now()
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createSignature(encoded);

  return `${encoded}.${signature}`;
}

function createSignature(encodedPayload) {
  return createHmac('sha256', TOKEN_SECRET).update(encodedPayload).digest('base64url');
}

function isTokenValidForClient(token, clientId) {
  if (!token) {
    return false;
  }

  const sanitizedClientId = sanitizeClientId(clientId);
  if (!sanitizedClientId) {
    return false;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return false;
  }

  let expectedSignature;
  try {
    expectedSignature = createSignature(encodedPayload);
  } catch (error) {
    return false;
  }

  let signatureBuffer;
  let expectedBuffer;
  try {
    signatureBuffer = Buffer.from(signature, 'base64url');
    expectedBuffer = Buffer.from(expectedSignature, 'base64url');
  } catch (error) {
    return false;
  }

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }

  let payload;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch (error) {
    return false;
  }

  if (payload.clientId !== sanitizedClientId) {
    return false;
  }

  if (typeof payload.createdAtMs !== 'number') {
    return false;
  }

  if (TOKEN_TTL_MS > 0 && payload.createdAtMs + TOKEN_TTL_MS < Date.now()) {
    return false;
  }

  return true;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

function normalizeDescription(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 80) {
    return null;
  }

  return normalized;
}
