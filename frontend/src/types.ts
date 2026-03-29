export interface ClientState {
  clientId: string;
  username: string | null;
  connected: boolean;
  lastSeenAtMs: number;
}

export interface ExpenseSplit {
  participantName: string;
  weight: number;
  shareCents: number;
}

export interface Expense {
  id: string;
  description: string;
  amountCents: number;
  paidByName: string;
  createdAtMs: number;
  splits: ExpenseSplit[];
}

export interface Balance {
  name: string;
  netCents: number;
}

export interface SettlementTransfer {
  fromName: string;
  toName: string;
  amountCents: number;
}

export interface Snapshot {
  serverNowMs: number;
  currency: string;
  people: string[];
  knownNames: string[];
  expenses: Expense[];
  balances: Balance[];
  settlements: SettlementTransfer[];
  clients: ClientState[];
  self: ClientState;
}

export interface SessionData extends ClientState {
  isAdmin?: boolean;
  tabId?: string;
  tabName?: string;
  tabCurrency?: string | null;
}

export interface SessionResponse {
  ok: boolean;
  session: SessionData;
}

export type ServerMessage =
  | {
      type: 'state';
      snapshot: Snapshot;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'pong';
      serverNowMs: number;
    };

export type ClientMessage =
  | {
      type: 'set_username';
      username: string;
    }
  | {
      type: 'add_person';
      name: string;
    }
  | {
      type: 'remove_person';
      name: string;
    }
  | {
      type: 'add_expense';
      description: string;
      amount: number;
      paidByName: string;
      splits: Array<{
        participantName: string;
        weight: number;
      }>;
    }
  | {
      type: 'remove_expense';
      id: string;
    }
  | {
      type: 'ping';
    };
