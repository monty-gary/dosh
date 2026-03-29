import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL, WS_URL, authenticate, getSession } from './api';
import type { ClientMessage, ServerMessage, Snapshot } from './types';

const STORAGE_CLIENT_ID = 'dosh.clientId';
const STORAGE_AUTH_TOKEN = 'dosh.authToken';

type AuthPhase = 'checking' | 'required' | 'ready';
type ConnectionState = 'offline' | 'connecting' | 'online';

interface SplitRow {
  participantName: string;
  weight: string;
}

function App() {
  const [clientId] = useState<string>(getOrCreateClientId);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(STORAGE_AUTH_TOKEN));
  const [authPhase, setAuthPhase] = useState<AuthPhase>(authToken ? 'checking' : 'required');

  const [passwordInput, setPasswordInput] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const [descriptionInput, setDescriptionInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [paidByName, setPaidByName] = useState('');
  const [splitRows, setSplitRows] = useState<SplitRow[]>([{ participantName: '', weight: '1' }]);
  const [newPersonInput, setNewPersonInput] = useState('');

  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [showPersonModal, setShowPersonModal] = useState(false);

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
      .then(() => {
        if (!cancelled) {
          setAuthPhase('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearAuth();
          setErrorMessage('Session expired. Enter the password again.');
        }
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

    const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(authToken)}&clientId=${encodeURIComponent(clientId)}`);
    socketRef.current = ws;

    ws.onopen = () => setConnectionState('online');

    ws.onmessage = (event) => {
      const message = safeParseMessage(event.data);
      if (!message) {
        return;
      }

      if (message.type === 'state') {
        setSnapshot(message.snapshot);
        setClockOffsetMs(message.snapshot.serverNowMs - Date.now());
        setErrorMessage(null);
      } else if (message.type === 'error') {
        setErrorMessage(message.message);
      } else if (message.type === 'pong') {
        setClockOffsetMs(message.serverNowMs - Date.now());
      }
    };

    ws.onerror = () => setConnectionState('offline');
    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
      setConnectionState('offline');
    };

    const pingId = window.setInterval(() => sendWsMessage({ type: 'ping' }), 5000);

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

  const people = snapshot?.people || [];

  useEffect(() => {
    if (!people.length) {
      setPaidByName('');
      setSplitRows([{ participantName: '', weight: '1' }]);
      return;
    }

    setPaidByName((current) => (current && people.includes(current) ? current : people[0]));
    setSplitRows((rows) => rows.map((row) => ({ ...row, participantName: row.participantName && people.includes(row.participantName) ? row.participantName : people[0] })));
  }, [people]);

  const onSubmitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsWorking(true);

    try {
      const result = await authenticate(passwordInput, clientId);
      setAuthToken(result.token);
      localStorage.setItem(STORAGE_AUTH_TOKEN, result.token);
      setAuthPhase('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Password check failed');
    } finally {
      setIsWorking(false);
    }
  };

  const onAddPerson = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = normalizeText(newPersonInput);
    if (name.length < 1 || name.length > 24) {
      setErrorMessage('Person name must be 1-24 characters.');
      return;
    }

    sendWsMessage({ type: 'add_person', name });
    setNewPersonInput('');
    setShowPersonModal(false);
  };

  const onRemovePerson = (name: string) => {
    sendWsMessage({ type: 'remove_person', name });
  };

  const onRemoveExpense = (id: string) => {
    sendWsMessage({ type: 'remove_expense', id });
  };

  const onUpdateSplitRow = (index: number, field: keyof SplitRow, value: string) => {
    setSplitRows((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const onAddSplitRow = () => setSplitRows((rows) => [...rows, { participantName: people[0] || '', weight: '1' }]);
  const onRemoveSplitRow = (index: number) => setSplitRows((rows) => rows.filter((_, i) => i !== index));

  const onSubmitExpense = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (people.length === 0) {
      setErrorMessage('Add people first.');
      return;
    }

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

    if (!paidByName || !people.includes(paidByName)) {
      setErrorMessage('Choose who paid.');
      return;
    }

    const splits = splitRows
      .map((row) => ({ participantName: row.participantName, weight: Number(row.weight) }))
      .filter((s) => s.participantName.length > 0);

    if (!splits.length) {
      setErrorMessage('Add at least one person in "For whom".');
      return;
    }

    if (splits.some((s) => !people.includes(s.participantName))) {
      setErrorMessage('Each split participant must be selected from people list.');
      return;
    }

    if (splits.some((s) => !Number.isFinite(s.weight) || s.weight <= 0)) {
      setErrorMessage('Each weight must be a positive number.');
      return;
    }

    sendWsMessage({
      type: 'add_expense',
      description,
      amount,
      paidByName,
      splits
    });

    setDescriptionInput('');
    setAmountInput('');
    setSplitRows([{ participantName: people[0] || '', weight: '1' }]);
    setShowExpenseModal(false);
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
          <section className="panel action-panel">
            <div className="inline-grid">
              <button type="button" onClick={() => setShowExpenseModal(true)}>Add Expense</button>
              <button type="button" onClick={() => setShowPersonModal(true)}>Add Person</button>
            </div>
          </section>

          <section className="panel">
            <h2>Who pays whom</h2>
            {snapshot?.settlements.length ? (
              <ul className="settlement-list">
                {snapshot.settlements.map((transfer, index) => (
                  <li key={`${transfer.fromName}-${transfer.toName}-${index}`}>
                    <span>
                      <b>{transfer.fromName}</b> pays <b>{transfer.toName}</b>
                    </span>
                    <strong>{formatMoney(transfer.amountCents)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Everyone is square.</p>
            )}
          </section>

          <section className="panel">
            <h2>Balances</h2>
            {snapshot?.balances.length ? (
              <ul className="metric-list">
                {snapshot.balances.map((balance) => (
                  <li key={balance.name}>
                    <span>{balance.name}</span>
                    <strong className={balance.netCents < 0 ? 'neg' : balance.netCents > 0 ? 'pos' : ''}>
                      {formatSignedMoney(balance.netCents)}
                    </strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No expenses yet.</p>
            )}
          </section>

          <section className="panel">
            <h2>Expenses</h2>
            {snapshot?.expenses.length ? (
              <ul className="expense-list">
                {[...snapshot.expenses].reverse().map((expense) => (
                  <li key={expense.id}>
                    <div>
                      <strong>{expense.description}</strong>
                      <p>{expense.paidByName} paid {formatMoney(expense.amountCents)}</p>
                    </div>
                    <div className="expense-right">
                      <div className="split-readout">
                        {expense.splits.map((split) => (
                          <span key={`${expense.id}-${split.participantName}`}>
                            {split.participantName}: {formatMoney(split.shareCents)} ({split.weight})
                          </span>
                        ))}
                      </div>
                      <button type="button" className="danger-icon" onClick={() => onRemoveExpense(expense.id)}>−</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No expenses yet.</p>
            )}
          </section>

          <section className="panel">
            <h2>People</h2>
            {people.length ? (
              <ul className="metric-list">
                {people.map((name) => (
                  <li key={name}>
                    <span>{name}</span>
                    <button type="button" className="danger-icon" onClick={() => onRemovePerson(name)}>−</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No people yet.</p>
            )}
          </section>
        </div>

        <div className="api-line">API URL: {API_BASE_URL}</div>

        <footer className="footer-note">
          <span>Server time skew: {clockOffsetMs >= 0 ? '+' : ''}{clockOffsetMs}ms</span>
        </footer>
      </section>

      {showExpenseModal ? (
        <div className="modal-backdrop" onClick={() => setShowExpenseModal(false)}>
          <div className="modal card" onClick={(event) => event.stopPropagation()}>
            <h2>Add Expense</h2>
            <form className="form-stack" onSubmit={onSubmitExpense}>
              <div>
                <label htmlFor="desc">Description</label>
                <input id="desc" type="text" maxLength={80} value={descriptionInput} onChange={(event) => setDescriptionInput(event.target.value)} />
              </div>

              <div className="inline-grid">
                <div>
                  <label htmlFor="amount">Amount</label>
                  <input id="amount" type="number" min="0" step="0.01" inputMode="decimal" value={amountInput} onChange={(event) => setAmountInput(event.target.value)} />
                </div>
                <div>
                  <label htmlFor="payer">Who paid</label>
                  <select id="payer" value={paidByName} onChange={(event) => setPaidByName(event.target.value)} disabled={!people.length}>
                    {people.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
              </div>

              <div className="for-whom">
                <label>For whom</label>
                <div className="split-rows">
                  {splitRows.map((row, index) => (
                    <div className="split-row-input" key={index}>
                      <select value={row.participantName} onChange={(event) => onUpdateSplitRow(index, 'participantName', event.target.value)} disabled={!people.length}>
                        {people.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                      <input type="number" min="0" step="0.1" inputMode="decimal" value={row.weight} onChange={(event) => onUpdateSplitRow(index, 'weight', event.target.value)} />
                      {splitRows.length > 1 ? <button type="button" className="ghost remove-btn" onClick={() => onRemoveSplitRow(index)}>✕</button> : null}
                    </div>
                  ))}
                </div>
                <button type="button" className="ghost" onClick={onAddSplitRow} disabled={!people.length}>+ Add person</button>
              </div>

              <div className="inline-grid">
                <button type="submit" disabled={!people.length}>Save</button>
                <button type="button" className="ghost" onClick={() => setShowExpenseModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showPersonModal ? (
        <div className="modal-backdrop" onClick={() => setShowPersonModal(false)}>
          <div className="modal card" onClick={(event) => event.stopPropagation()}>
            <h2>Add Person</h2>
            <form className="form-stack" onSubmit={onAddPerson}>
              <div>
                <label htmlFor="personName">Name</label>
                <input id="personName" type="text" maxLength={24} value={newPersonInput} onChange={(event) => setNewPersonInput(event.target.value)} />
              </div>
              <div className="inline-grid">
                <button type="submit">Save</button>
                <button type="button" className="ghost" onClick={() => setShowPersonModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
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

  const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
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
