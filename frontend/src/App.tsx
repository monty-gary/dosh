import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, WS_URL, authenticate, createTab, deleteTab, getSession, listTabs, type AdminTab } from './api';
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [tabName, setTabName] = useState<string | null>(null);
  const [tabCurrency, setTabCurrency] = useState<string>('Kč');

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const [descriptionInput, setDescriptionInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [paidByName, setPaidByName] = useState('');
  const [splitRows, setSplitRows] = useState<SplitRow[]>([{ participantName: '', weight: '1' }]);
  const [newPersonInput, setNewPersonInput] = useState('');
  const [paymentAmountInput, setPaymentAmountInput] = useState('');
  const [paymentFromName, setPaymentFromName] = useState('');
  const [paymentToName, setPaymentToName] = useState('');
  const [paymentNoteInput, setPaymentNoteInput] = useState('');

  const [adminTabs, setAdminTabs] = useState<AdminTab[]>([]);
  const [newTabName, setNewTabName] = useState('');
  const [newTabPassword, setNewTabPassword] = useState('');
  const [newTabCurrency, setNewTabCurrency] = useState('Kč');

  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [showPersonModal, setShowPersonModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

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
    setIsAdmin(false);
    setTabName(null);
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }, []);

  const refreshTabs = useCallback(async () => {
    if (!authToken) {
      return;
    }

    const tabs = await listTabs(authToken);
    setAdminTabs(tabs);
  }, [authToken]);

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
      .then(async (session) => {
        if (cancelled) {
          return;
        }

        const admin = Boolean(session.isAdmin);
        setIsAdmin(admin);
        setTabName(session.tabName || null);
        if (!admin && session.tabCurrency) {
          setTabCurrency(session.tabCurrency);
        }
        setAuthPhase('ready');

        if (admin) {
          await refreshTabs();
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
  }, [authToken, clientId, clearAuth, refreshTabs]);

  useEffect(() => {
    if (authPhase !== 'ready' || !authToken || isAdmin) {
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
        if (message.snapshot.currency) {
          setTabCurrency(message.snapshot.currency);
        }
        setClockOffsetMs(message.snapshot.serverNowMs - Date.now());
        setErrorMessage(null);
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
  }, [authPhase, authToken, clientId, isAdmin, sendWsMessage]);

  const isOffline = connectionState !== 'online';
  const people = snapshot?.people || [];
  const settlements = snapshot?.settlements || [];
  const expenses = snapshot?.expenses || [];

  const paymentExpenses = useMemo(
    () => expenses.filter((expense) => expense.description.startsWith('PAY:')),
    [expenses]
  );

  const regularExpenses = useMemo(
    () => expenses.filter((expense) => !expense.description.startsWith('PAY:')),
    [expenses]
  );

  useEffect(() => {
    if (!people.length) {
      setPaidByName('');
      setSplitRows([{ participantName: '', weight: '1' }]);
      setPaymentFromName('');
      setPaymentToName('');
      return;
    }

    setPaidByName((current) => (current && people.includes(current) ? current : people[0]));

    setSplitRows((rows) => {
      const used = new Set<string>();
      return rows.map((row) => {
        const valid = row.participantName && people.includes(row.participantName) && !used.has(row.participantName)
          ? row.participantName
          : people.find((name) => !used.has(name)) || '';

        if (valid) {
          used.add(valid);
        }

        return {
          ...row,
          participantName: valid
        };
      });
    });

    setPaymentFromName((current) => (current && people.includes(current) ? current : people[0]));
    setPaymentToName((current) => {
      if (current && people.includes(current)) {
        return current;
      }
      return people.length > 1 ? people[1] : people[0];
    });
  }, [people]);

  const usedSplitPeople = useMemo(() => new Set(splitRows.map((row) => row.participantName).filter(Boolean)), [splitRows]);
  const canAddSplitRow = people.some((name) => !usedSplitPeople.has(name));

  const onSubmitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsWorking(true);

    try {
      const result = await authenticate(passwordInput, clientId);
      setAuthToken(result.token);
      localStorage.setItem(STORAGE_AUTH_TOKEN, result.token);
      setAuthPhase('ready');
      setIsAdmin(Boolean(result.session.isAdmin));
      setTabName(result.session.tabName || null);
      if (!result.session.isAdmin && result.session.tabCurrency) {
        setTabCurrency(result.session.tabCurrency);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Password check failed');
    } finally {
      setIsWorking(false);
    }
  };

  const onAddPerson = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

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
    if (!window.confirm(`Remove ${name}?`)) {
      return;
    }

    setErrorMessage(null);
    sendWsMessage({ type: 'remove_person', name });
  };

  const onRemoveExpense = (id: string) => {
    setErrorMessage(null);
    sendWsMessage({ type: 'remove_expense', id });
  };

  const onUpdateSplitRow = (index: number, field: keyof SplitRow, value: string) => {
    const nextValue = field === 'weight' ? sanitizeDecimalInput(value) : value;
    setSplitRows((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: nextValue } : row)));
  };

  const onAddSplitRow = () => {
    const used = new Set(splitRows.map((row) => row.participantName).filter(Boolean));
    const next = people.find((name) => !used.has(name));
    if (!next) {
      return;
    }

    setSplitRows((rows) => [...rows, { participantName: next, weight: '1' }]);
  };

  const onRemoveSplitRow = (index: number) => {
    setSplitRows((rows) => rows.filter((_, i) => i !== index));
  };

  const availablePeopleForRow = (index: number) => {
    const current = splitRows[index]?.participantName || '';
    const usedByOthers = new Set(
      splitRows
        .filter((_, i) => i !== index)
        .map((row) => row.participantName)
        .filter(Boolean)
    );

    return people.filter((name) => name === current || !usedByOthers.has(name));
  };

  const onSubmitExpense = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

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

    if (splits.length === 0) {
      setErrorMessage('Add at least one person in "For whom".');
      return;
    }

    const dedup = new Set<string>();
    for (const split of splits) {
      if (!people.includes(split.participantName)) {
        setErrorMessage('Each split participant must be selected from people list.');
        return;
      }

      if (dedup.has(split.participantName)) {
        setErrorMessage('Each person can be in "For whom" only once.');
        return;
      }
      dedup.add(split.participantName);

      if (!Number.isFinite(split.weight) || split.weight <= 0) {
        setErrorMessage('Each weight must be a positive number.');
        return;
      }
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

  const addPaymentExpense = (fromName: string, toName: string, amountCents: number, note = '') => {
    if (!fromName || !toName || fromName === toName || amountCents <= 0) {
      return;
    }

    const normalizedNote = normalizeText(note).slice(0, 76);
    const description = normalizedNote ? `PAY:${normalizedNote}` : `PAY:${fromName}->${toName}`;
    sendWsMessage({
      type: 'add_expense',
      description,
      amount: amountCents / 100,
      paidByName: fromName,
      splits: [{ participantName: toName, weight: 1 }]
    });
  };

  const onAddSuggestedPayment = (fromName: string, toName: string, amountCents: number) => {
    setErrorMessage(null);
    addPaymentExpense(fromName, toName, amountCents);
  };

  const onAddCustomPayment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    const amount = Number(paymentAmountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage('Payment amount must be positive.');
      return;
    }

    if (!people.includes(paymentFromName) || !people.includes(paymentToName)) {
      setErrorMessage('Payment from/to must be selected from people list.');
      return;
    }

    if (paymentFromName === paymentToName) {
      setErrorMessage('Payment must be between two different people.');
      return;
    }

    addPaymentExpense(paymentFromName, paymentToName, Math.round(amount * 100), paymentNoteInput);
    setPaymentAmountInput('');
    setPaymentNoteInput('');
  };

  const onSettled = () => {
    if (!settlements.length) {
      return;
    }

    if (!window.confirm(`Add ${settlements.length} payment${settlements.length === 1 ? '' : 's'} from Settle Up?`)) {
      return;
    }

    setErrorMessage(null);
    for (const transfer of settlements) {
      addPaymentExpense(transfer.fromName, transfer.toName, transfer.amountCents);
    }
  };

  const onCreateTab = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authToken) {
      return;
    }

    setErrorMessage(null);

    const name = normalizeText(newTabName);
    const password = newTabPassword.trim();
    const currency = newTabCurrency.trim();

    if (name.length < 1 || name.length > 40) {
      setErrorMessage('Tab name must be 1-40 characters.');
      return;
    }

    if (password.length < 1 || password.length > 80) {
      setErrorMessage('Tab password must be 1-80 characters.');
      return;
    }

    if (currency.length < 1 || currency.length > 5) {
      setErrorMessage('Currency must be 1-5 characters.');
      return;
    }

    try {
      await createTab(authToken, name, password, currency);
      setNewTabName('');
      setNewTabPassword('');
      setNewTabCurrency('Kč');
      await refreshTabs();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create tab');
    }
  };

  const onDeleteTab = async (tabId: string, tabTitle: string) => {
    if (!authToken) {
      return;
    }

    if (!window.confirm(`Delete tab “${tabTitle}”? This cannot be undone.`)) {
      return;
    }

    setErrorMessage(null);

    try {
      await deleteTab(authToken, tabId);
      await refreshTabs();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete tab');
    }
  };

  if (authPhase === 'required' || authPhase === 'checking') {
    return (
      <div className="app-shell">
        <section className="card gate-card">
          <h1>dosh</h1>
          <p>Shared tab splitting</p>

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

  if (isAdmin) {
    return (
      <div className="app-shell main-shell">
        <section className="app-frame">
          <header className="topbar">
            <div>
              <h1>Tab Admin</h1>
              <p>Create and delete tabs.</p>
            </div>
            <div className="topbar-right">
              <button className="ghost" onClick={() => {
                clearAuth();
                setPasswordInput('');
              }}>
                Exit Admin
              </button>
            </div>
          </header>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

          <section className="panel">
            <h2>Create tab</h2>
            <form className="form-stack" onSubmit={onCreateTab}>
              <div>
                <label htmlFor="tabName">Tab name</label>
                <input id="tabName" type="text" value={newTabName} onChange={(event) => setNewTabName(event.target.value)} maxLength={40} />
              </div>
              <div>
                <label htmlFor="tabPassword">Tab password</label>
                <input id="tabPassword" type="password" value={newTabPassword} onChange={(event) => setNewTabPassword(event.target.value)} maxLength={80} />
              </div>
              <div>
                <label htmlFor="tabCurrency">Currency (1-5 chars)</label>
                <input id="tabCurrency" type="text" value={newTabCurrency} onChange={(event) => setNewTabCurrency(event.target.value)} maxLength={5} />
              </div>
              <button type="submit">Create tab</button>
            </form>
          </section>

          <section className="panel">
            <h2>Existing tabs</h2>
            {adminTabs.length ? (
              <ul className="metric-list">
                {adminTabs.map((tab) => (
                  <li key={tab.id}>
                    <span>{tab.name} ({tab.currency}) · {tab.people} people · {tab.expenses} expenses</span>
                    <button type="button" className="danger-icon" onClick={() => onDeleteTab(tab.id, tab.name)}>−</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No tabs yet.</p>
            )}
          </section>

          <div className="api-line">API URL: {API_BASE_URL}</div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell main-shell">
      <section className="app-frame">
        <header className="topbar">
          <div>
            <div className="title-row">
              <h1>dosh</h1>
              <div className="status-pill">
                <span>{connectionState === 'online' ? 'Live' : 'Offline'}</span>
              </div>
            </div>
            <p>{tabName || 'Tab'}</p>
          </div>

          <div className="topbar-right">
            <button
              className="ghost"
              onClick={() => {
                clearAuth();
                setPasswordInput('');
              }}
            >
              Leave
            </button>
          </div>
        </header>

        {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        {connectionState !== 'online' ? (
          <p className="hint">Connecting… If Render is sleeping, wake-up can take up to ~60s.</p>
        ) : null}

        <div className="main-grid">
          <section className="panel action-panel">
            <div className="action-buttons">
              <button type="button" disabled={isOffline} onClick={() => setShowExpenseModal(true)}>Add Expense</button>
              <button type="button" disabled={isOffline} onClick={() => setShowPersonModal(true)}>Add Person</button>
            </div>
            <div className="action-buttons">
              <button type="button" disabled={isOffline} onClick={() => setShowPaymentModal(true)}>Add Payment</button>
              <button type="button" disabled={isOffline || !settlements.length} onClick={onSettled}>Settled!</button>
            </div>
          </section>

          <section className="panel">
            <h2>Settle Up</h2>
            {settlements.length ? (
              <ul className="settlement-list">
                {settlements.map((transfer, index) => (
                  <li key={`${transfer.fromName}-${transfer.toName}-${index}`}>
                    <span>
                      <b>{transfer.fromName}</b> pays <b>{transfer.toName}</b>
                    </span>
                    <strong>{formatMoney(transfer.amountCents, tabCurrency)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Everyone is square.</p>
            )}
          </section>

          <section className="panel">
            <h2>Expenses</h2>
            {regularExpenses.length || paymentExpenses.length ? (
              <ul className="expense-list">
                {[...regularExpenses].reverse().map((expense) => (
                  <li key={expense.id} className="expense-item">
                    <div className="expense-header">
                      <strong className="expense-title">{expense.description}</strong>
                      <button type="button" className="danger-icon" disabled={isOffline} onClick={() => onRemoveExpense(expense.id)}>−</button>
                    </div>
                    <div className="expense-meta">
                      <span>{expense.paidByName} paid</span>
                      <span className="expense-amount">{formatMoney(expense.amountCents, tabCurrency)}</span>
                    </div>
                    <div className="split-readout">
                      {expense.splits.map((split) => (
                        <span key={`${expense.id}-${split.participantName}`}>
                          {split.participantName} × {split.weight}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
                {[...paymentExpenses].reverse().map((payment) => {
                  const payee = payment.splits[0]?.participantName || 'Unknown';
                  const paymentLabel = getPaymentLabel(payment.description);
                  return (
                    <li key={payment.id} className="payment-item">
                      <div className="expense-header">
                        <strong>{paymentLabel ? `Payment (${paymentLabel})` : 'Payment'}</strong>
                        <button type="button" className="danger-icon" disabled={isOffline} onClick={() => onRemoveExpense(payment.id)}>−</button>
                      </div>
                      <p>{payment.paidByName} paid {payee} {formatMoney(payment.amountCents, tabCurrency)}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="hint">No expenses yet.</p>
            )}
          </section>

          <section className="panel">
            <h2>Balance</h2>
            {snapshot?.balances.length ? (
              <ul className="metric-list">
                {snapshot.balances.map((balance) => (
                  <li key={balance.name}>
                    <span>{balance.name}</span>
                    <div className="topbar-right">
                      <strong className={balance.netCents < 0 ? 'neg' : balance.netCents > 0 ? 'pos' : ''}>
                        {formatSignedMoney(balance.netCents, tabCurrency)}
                      </strong>
                      <button type="button" className="danger-icon" disabled={isOffline} onClick={() => onRemovePerson(balance.name)}>−</button>
                    </div>
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
                <input
                  id="desc"
                  type="text"
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
                    type="text"
                    inputMode="decimal"
                    pattern="[0-9]*[.]?[0-9]*"
                    value={amountInput}
                    onChange={(event) => setAmountInput(sanitizeDecimalInput(event.target.value))}
                  />
                </div>
                <div>
                  <label htmlFor="payer">Who paid</label>
                  <select
                    id="payer"
                    value={paidByName}
                    onChange={(event) => setPaidByName(event.target.value)}
                    disabled={people.length === 0}
                  >
                    {people.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="for-whom">
                <label>For whom</label>
                <div className="split-rows">
                  {splitRows.map((row, index) => (
                    <div className="split-row-input" key={index}>
                      <select
                        value={row.participantName}
                        onChange={(event) => onUpdateSplitRow(index, 'participantName', event.target.value)}
                        disabled={people.length === 0}
                      >
                        {availablePeopleForRow(index).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9]*[.]?[0-9]*"
                        value={row.weight}
                        onChange={(event) => onUpdateSplitRow(index, 'weight', event.target.value)}
                      />
                      {splitRows.length > 1 ? (
                        <button type="button" className="ghost remove-btn" onClick={() => onRemoveSplitRow(index)}>✕</button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <button type="button" className="ghost" onClick={onAddSplitRow} disabled={!canAddSplitRow}>
                  + Add person
                </button>
              </div>

              <div className="inline-grid">
                <button type="submit" disabled={isOffline || people.length === 0}>Save</button>
                <button type="button" className="ghost" onClick={() => setShowExpenseModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showPaymentModal ? (
        <div className="modal-backdrop" onClick={() => setShowPaymentModal(false)}>
          <div className="modal card" onClick={(event) => event.stopPropagation()}>
            <h2>Add Payment</h2>

            <div className="form-stack">
              <div>
                <label>From Settle Up</label>
                {settlements.length ? (
                  <ul className="settlement-list">
                    {settlements.map((transfer, index) => (
                      <li key={`${transfer.fromName}-${transfer.toName}-${index}`}>
                        <span>
                          <b>{transfer.fromName}</b> → <b>{transfer.toName}</b>
                        </span>
                        <div className="topbar-right">
                          <strong>{formatMoney(transfer.amountCents, tabCurrency)}</strong>
                          <button
                            type="button"
                            disabled={isOffline}
                            onClick={() => onAddSuggestedPayment(transfer.fromName, transfer.toName, transfer.amountCents)}
                          >
                            Add
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">No suggested payments.</p>
                )}
              </div>

              <form className="form-stack" onSubmit={onAddCustomPayment}>
                <label>Custom Payment</label>
                <div className="inline-grid">
                  <div>
                    <label htmlFor="paymentAmount">Amount</label>
                    <input
                      id="paymentAmount"
                      type="text"
                      inputMode="decimal"
                      pattern="[0-9]*[.]?[0-9]*"
                      value={paymentAmountInput}
                      onChange={(event) => setPaymentAmountInput(sanitizeDecimalInput(event.target.value))}
                    />
                  </div>
                  <div>
                    <label htmlFor="paymentFrom">From</label>
                    <select
                      id="paymentFrom"
                      value={paymentFromName}
                      onChange={(event) => setPaymentFromName(event.target.value)}
                    >
                      {people.filter((name) => name !== paymentToName).map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="paymentTo">To</label>
                  <select
                    id="paymentTo"
                    value={paymentToName}
                    onChange={(event) => setPaymentToName(event.target.value)}
                  >
                    {people.filter((name) => name !== paymentFromName).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="paymentNote">Note (optional)</label>
                  <input
                    id="paymentNote"
                    type="text"
                    maxLength={76}
                    value={paymentNoteInput}
                    onChange={(event) => setPaymentNoteInput(event.target.value)}
                  />
                </div>

                <div className="inline-grid">
                  <button type="submit" disabled={isOffline || people.length < 2}>Add Payment</button>
                  <button type="button" className="ghost" onClick={() => setShowPaymentModal(false)}>Cancel</button>
                </div>
              </form>
            </div>
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
                <input
                  id="personName"
                  type="text"
                  maxLength={24}
                  value={newPersonInput}
                  onChange={(event) => setNewPersonInput(event.target.value)}
                />
              </div>
              <div className="inline-grid">
                <button type="submit" disabled={isOffline}>Save</button>
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

function sanitizeDecimalInput(value: string, maxFractionDigits = 2): string {
  const normalized = value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const firstDotIndex = normalized.indexOf('.');
  if (firstDotIndex === -1) {
    return normalized;
  }

  const integerPart = normalized.slice(0, firstDotIndex + 1);
  const fractionPart = normalized
    .slice(firstDotIndex + 1)
    .replace(/\./g, '')
    .slice(0, Math.max(0, maxFractionDigits));

  return `${integerPart}${fractionPart}`;
}

function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const prefixCurrencies = new Set(['$', '€', '£', '¥']);
  if (prefixCurrencies.has(currency)) {
    return `${currency}${amount}`;
  }

  return `${amount}\u00A0${currency}`;
}

function getPaymentLabel(description: string): string {
  if (!description.startsWith('PAY:')) {
    return '';
  }

  const raw = description.slice(4).trim();
  if (!raw) {
    return '';
  }

  if (raw.includes('->')) {
    return '';
  }

  return raw;
}

function formatSignedMoney(cents: number, currency: string): string {
  if (cents > 0) {
    return `+${formatMoney(cents, currency)}`;
  }

  if (cents < 0) {
    return `-${formatMoney(Math.abs(cents), currency)}`;
  }

  return formatMoney(0, currency);
}

export default App;
