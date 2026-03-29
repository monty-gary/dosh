import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, WS_URL, authenticate, getSession } from './api';
import type {
  Balance,
  ClientMessage,
  ServerMessage,
  Snapshot
} from './types';

const STORAGE_CLIENT_ID = 'dosh.clientId';
const STORAGE_AUTH_TOKEN = 'dosh.authToken';
const STORAGE_USERNAME = 'dosh.username';

type AuthPhase = 'checking' | 'required' | 'ready';
type ConnectionState = 'offline' | 'connecting' | 'online';

interface DraftWeights {
  [participantId: string]: string;
}

function App() {
  const [clientId] = useState<string>(getOrCreateClientId);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(STORAGE_AUTH_TOKEN));
  const [authPhase, setAuthPhase] = useState<AuthPhase>(authToken ? 'checking' : 'required');

  const [passwordInput, setPasswordInput] = useState('');
  const [usernameInput, setUsernameInput] = useState<string>(() => localStorage.getItem(STORAGE_USERNAME) || '');

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const [descriptionInput, setDescriptionInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [paidByClientId, setPaidByClientId] = useState('');
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [draftWeights, setDraftWeights] = useState<DraftWeights>({});

  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  const sendWsMessage = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setErrorMessage('Realtime connection is not ready yet.');
      return;
    }

    socket.send(JSON.stringify(message));
  }, []);

  const clearAuth = useCallback(() => {
    setAuthToken(null);
    setAuthPhase('required');
    setSnapshot(null);
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!authToken) {
      setAuthPhase('required');
      setSnapshot(null);
      return () => {
        cancelled = true;
      };
    }

    setAuthPhase('checking');

    getSession(authToken, clientId)
      .then((session) => {
        if (cancelled) {
          return;
        }

        setAuthPhase('ready');
        if (session.username) {
          setUsernameInput(session.username);
          localStorage.setItem(STORAGE_USERNAME, session.username);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        clearAuth();
        setErrorMessage('Session expired. Enter the password again.');
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, clientId, clearAuth]);

  useEffect(() => {
    if (authPhase !== 'ready' || !authToken) {
      return;
    }

    setConnectionState('connecting');

    const ws = new WebSocket(
      `${WS_URL}/ws?token=${encodeURIComponent(authToken)}&clientId=${encodeURIComponent(clientId)}`
    );

    socketRef.current = ws;

    ws.onopen = () => {
      setConnectionState('online');
    };

    ws.onmessage = (event) => {
      const message = safeParseMessage(event.data);
      if (!message) {
        return;
      }

      if (message.type === 'state') {
        setSnapshot(message.snapshot);
        setClockOffsetMs(message.snapshot.serverNowMs - Date.now());
        setErrorMessage(null);

        if (message.snapshot.self.username) {
          setUsernameInput(message.snapshot.self.username);
          localStorage.setItem(STORAGE_USERNAME, message.snapshot.self.username);
        }

        return;
      }

      if (message.type === 'error') {
        setErrorMessage(message.message);
        return;
      }

      if (message.type === 'pong') {
        setClockOffsetMs(message.serverNowMs - Date.now());
      }
    };

    ws.onerror = () => {
      setConnectionState('offline');
    };

    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }

      setConnectionState('offline');
    };

    const pingId = window.setInterval(() => {
      sendWsMessage({ type: 'ping' });
    }, 5000);

    return () => {
      window.clearInterval(pingId);

      if (socketRef.current === ws) {
        socketRef.current = null;
      }

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [authPhase, authToken, clientId, sendWsMessage]);

  const participants = snapshot?.participants || [];
  const self = snapshot?.self || null;
  const hasUsername = Boolean(self?.username);

  useEffect(() => {
    if (!participants.length) {
      setPaidByClientId('');
      setSelectedParticipantIds([]);
      setDraftWeights({});
      return;
    }

    setPaidByClientId((current) => {
      if (current && participants.some((participant) => participant.clientId === current)) {
        return current;
      }

      if (self?.clientId && participants.some((participant) => participant.clientId === self.clientId)) {
        return self.clientId;
      }

      return participants[0].clientId;
    });

    setSelectedParticipantIds((current) => {
      const validCurrent = current.filter((id) => participants.some((participant) => participant.clientId === id));
      if (validCurrent.length > 0) {
        return validCurrent;
      }

      if (self?.clientId && participants.some((participant) => participant.clientId === self.clientId)) {
        return [self.clientId];
      }

      return [participants[0].clientId];
    });

    setDraftWeights((current) => {
      const next: DraftWeights = {};
      for (const participant of participants) {
        if (current[participant.clientId]) {
          next[participant.clientId] = current[participant.clientId];
        }
      }

      return next;
    });
  }, [participants, self?.clientId]);

  const balancesById = useMemo(() => {
    const map = new Map<string, Balance>();

    for (const balance of snapshot?.balances || []) {
      map.set(balance.participantClientId, balance);
    }

    return map;
  }, [snapshot?.balances]);

  const onSubmitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsWorking(true);

    try {
      const result = await authenticate(passwordInput, clientId);
      setAuthToken(result.token);
      localStorage.setItem(STORAGE_AUTH_TOKEN, result.token);
      setAuthPhase('ready');
      if (result.session.username) {
        setUsernameInput(result.session.username);
        localStorage.setItem(STORAGE_USERNAME, result.session.username);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Password check failed');
    } finally {
      setIsWorking(false);
    }
  };

  const onSubmitUsername = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    const normalized = normalizeText(usernameInput);
    if (normalized.length < 2 || normalized.length > 24) {
      setErrorMessage('Name must be 2-24 characters.');
      return;
    }

    sendWsMessage({
      type: 'set_username',
      username: normalized
    });
  };

  const onToggleParticipant = (participantId: string) => {
    setSelectedParticipantIds((current) => {
      if (current.includes(participantId)) {
        return current.filter((id) => id !== participantId);
      }

      return [...current, participantId];
    });

    setDraftWeights((current) => ({
      ...current,
      [participantId]: current[participantId] || '1'
    }));
  };

  const onChangeWeight = (participantId: string, value: string) => {
    setDraftWeights((current) => ({
      ...current,
      [participantId]: value
    }));
  };

  const onSubmitExpense = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    const description = normalizeText(descriptionInput);
    if (description.length < 2 || description.length > 80) {
      setErrorMessage('Description must be 2-80 characters.');
      return;
    }

    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage('Amount must be a positive number.');
      return;
    }

    if (!paidByClientId) {
      setErrorMessage('Choose who paid.');
      return;
    }

    const splits = selectedParticipantIds.map((participantClientId) => {
      const rawWeight = draftWeights[participantClientId] || '1';
      return {
        participantClientId,
        weight: Number(rawWeight)
      };
    });

    if (splits.length === 0) {
      setErrorMessage('Choose at least one person in “For whom”.');
      return;
    }

    if (splits.some((split) => !Number.isFinite(split.weight) || split.weight <= 0)) {
      setErrorMessage('Each weight must be a positive number.');
      return;
    }

    sendWsMessage({
      type: 'add_expense',
      description,
      amount,
      paidByClientId,
      splits
    });

    setDescriptionInput('');
    setAmountInput('');
  };

  if (authPhase === 'required' || authPhase === 'checking') {
    return (
      <div className="app-shell">
        <section className="card gate-card">
          <h1>dosh</h1>
          <p>Shared tab splitting, live for everyone in the room.</p>
          <p className="hint">Enter the shared password to continue.</p>

          <form className="form-stack" onSubmit={onSubmitPassword}>
            <div>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="•••••"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                disabled={isWorking || authPhase === 'checking'}
              />
            </div>

            <button type="submit" disabled={isWorking || authPhase === 'checking' || passwordInput.length === 0}>
              {authPhase === 'checking' ? 'Checking session…' : isWorking ? 'Checking…' : 'Enter'}
            </button>
          </form>

          <div className="status-row">
            <span>API</span>
            <code>{API_BASE_URL}</code>
          </div>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </section>
      </div>
    );
  }

  if (!hasUsername) {
    return (
      <div className="app-shell">
        <section className="card gate-card">
          <h1>Who’s joining?</h1>
          <p>Choose a display name so others can add you to expense splits.</p>

          <form className="form-stack" onSubmit={onSubmitUsername}>
            <div>
              <label htmlFor="username">Your name</label>
              <input
                id="username"
                type="text"
                autoComplete="nickname"
                value={usernameInput}
                onChange={(event) => setUsernameInput(event.target.value)}
                maxLength={24}
                placeholder="Alex"
              />
            </div>

            <button type="submit" disabled={usernameInput.trim().length < 2}>
              Continue
            </button>
          </form>

          <p className="hint">Connected: {connectionState}</p>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell main-shell">
      <section className="app-frame">
        <header className="topbar">
          <div>
            <h1>dosh</h1>
            <p>Split shared costs with weighted ratios.</p>
          </div>

          <div className="topbar-right">
            <div className="status-pill">
              <span>{connectionState === 'online' ? 'Live' : 'Offline'}</span>
            </div>
            <button
              className="ghost"
              onClick={() => {
                clearAuth();
                setPasswordInput('');
              }}
            >
              Lock
            </button>
          </div>
        </header>

        {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

        <div className="main-grid">
          <section className="panel form-panel">
            <h2>Add expense</h2>
            <form className="form-stack" onSubmit={onSubmitExpense}>
              <div>
                <label htmlFor="desc">Description</label>
                <input
                  id="desc"
                  type="text"
                  placeholder="Dinner, tickets, taxi…"
                  maxLength={80}
                  value={descriptionInput}
                  onChange={(event) => setDescriptionInput(event.target.value)}
                />
              </div>

              <div className="inline-grid">
                <div>
                  <label htmlFor="amount">Amount</label>
                  <input
                    id="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                  />
                </div>

                <div>
                  <label htmlFor="payer">Who paid</label>
                  <select
                    id="payer"
                    value={paidByClientId}
                    onChange={(event) => setPaidByClientId(event.target.value)}
                  >
                    {participants.map((participant) => (
                      <option key={participant.clientId} value={participant.clientId}>
                        {participant.username}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="for-whom">
                <label>For whom</label>
                <div className="participant-list">
                  {participants.map((participant) => {
                    const selected = selectedParticipantIds.includes(participant.clientId);
                    return (
                      <label className={`participant-chip ${selected ? 'selected' : ''}`} key={participant.clientId}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => onToggleParticipant(participant.clientId)}
                        />
                        <span>{participant.username}</span>
                        <em>{participant.connected ? 'online' : 'away'}</em>
                      </label>
                    );
                  })}
                </div>
              </div>

              {selectedParticipantIds.length > 0 ? (
                <div className="weights-grid">
                  <label>Split weights (ratio)</label>
                  {selectedParticipantIds.map((participantId) => {
                    const participant = participants.find((entry) => entry.clientId === participantId);
                    if (!participant) {
                      return null;
                    }

                    return (
                      <div className="weight-row" key={participantId}>
                        <span>{participant.username}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          inputMode="decimal"
                          value={draftWeights[participantId] || '1'}
                          onChange={(event) => onChangeWeight(participantId, event.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <button type="submit" disabled={participants.length === 0}>
                Add expense
              </button>
            </form>
          </section>

          <section className="panel">
            <h2>Balances</h2>
            {snapshot?.balances.length ? (
              <ul className="metric-list">
                {snapshot.balances.map((balance) => (
                  <li key={balance.participantClientId}>
                    <span>{balance.username}</span>
                    <strong className={balance.netCents < 0 ? 'neg' : balance.netCents > 0 ? 'pos' : ''}>
                      {formatSignedMoney(balance.netCents)}
                    </strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No named participants yet.</p>
            )}
          </section>

          <section className="panel">
            <h2>Settle up</h2>
            {snapshot?.settlements.length ? (
              <ul className="settlement-list">
                {snapshot.settlements.map((transfer, index) => (
                  <li key={`${transfer.fromClientId}-${transfer.toClientId}-${index}`}>
                    <span>
                      <b>{transfer.fromUsername}</b> pays <b>{transfer.toUsername}</b>
                    </span>
                    <strong>{formatMoney(transfer.amountCents)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Everyone is square.</p>
            )}
          </section>

          <section className="panel span-two">
            <h2>Expenses</h2>
            {snapshot?.expenses.length ? (
              <ul className="expense-list">
                {[...snapshot.expenses].reverse().map((expense) => {
                  const payer = participants.find((participant) => participant.clientId === expense.paidByClientId);
                  return (
                    <li key={expense.id}>
                      <div>
                        <strong>{expense.description}</strong>
                        <p>
                          {payer?.username || 'Unknown'} paid {formatMoney(expense.amountCents)}
                        </p>
                      </div>
                      <div className="split-readout">
                        {expense.splits.map((split) => {
                          const participant = participants.find((entry) => entry.clientId === split.participantClientId);
                          return (
                            <span key={`${expense.id}-${split.participantClientId}`}>
                              {participant?.username || 'Unknown'}: {formatMoney(split.shareCents)} ({split.weight})
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="hint">No expenses yet.</p>
            )}
          </section>
        </div>

        <footer className="footer-note">
          <span>Server time skew: {clockOffsetMs >= 0 ? '+' : ''}{clockOffsetMs}ms</span>
          <span>Participants: {participants.length}</span>
          <span>You: {snapshot?.self.username}</span>
          {self ? (
            <span>
              Your net: <strong>{formatSignedMoney((balancesById.get(self.clientId)?.netCents || 0))}</strong>
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function safeParseMessage(raw: unknown): ServerMessage | null {
  try {
    if (typeof raw !== 'string') {
      return null;
    }

    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

function getOrCreateClientId(): string {
  const existing = localStorage.getItem(STORAGE_CLIENT_ID);
  if (existing) {
    return existing;
  }

  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `client-${Math.random().toString(36).slice(2, 11)}`;

  localStorage.setItem(STORAGE_CLIENT_ID, generated);
  return generated;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatSignedMoney(cents: number): string {
  if (cents > 0) {
    return `+${formatMoney(cents)}`;
  }

  if (cents < 0) {
    return `-${formatMoney(Math.abs(cents))}`;
  }

  return formatMoney(0);
}

export default App;
