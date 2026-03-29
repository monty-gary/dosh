export interface ClientState {
  clientId: string;
  username: string | null;
  connected: boolean;
  lastSeenAtMs: number;
}

export interface Participant {
  clientId: string;
  username: string;
  connected: boolean;
}

export interface ExpenseSplit {
  participantClientId: string;
  weight: number;
  shareCents: number;
}

export interface Expense {
  id: string;
  description: string;
  amountCents: number;
  paidByClientId: string;
  createdByClientId: string;
  createdAtMs: number;
  splits: ExpenseSplit[];
}

export interface Balance {
  participantClientId: string;
  username: string;
  netCents: number;
}

export interface SettlementTransfer {
  fromClientId: string;
  fromUsername: string;
  toClientId: string;
  toUsername: string;
  amountCents: number;
}

export interface Snapshot {
  serverNowMs: number;
  participants: Participant[];
  expenses: Expense[];
  balances: Balance[];
  settlements: SettlementTransfer[];
  clients: ClientState[];
  self: ClientState;
}

export interface SessionResponse {
  ok: boolean;
  session: ClientState;
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
      type: 'add_expense';
      description: string;
      amount: number;
      paidByClientId: string;
      splits: Array<{
        participantClientId: string;
        weight: number;
      }>;
    }
  | {
      type: 'ping';
    };
