// Cloudflare D1 bindings
export interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

// Database types
export interface Pair {
  id: string;
  pair_code_hash: string;
  last_chomp_at: number | null;
  created_at: number;
}

export interface Member {
  id: string;
  pair_id: string;
  device_id: string;
  push_endpoint: string | null;
  push_p256dh: string | null;
  push_auth: string | null;
  push_user_agent?: string | null;
  push_updated_at?: number | null;
  last_chomp_at: number | null;
  last_received_at: number | null;
  created_at: number;
}

// Junction table for dual-slot pairing support
export interface MemberPair {
  member_id: string;
  pair_id: string;
  slot: 1 | 2;
  last_sent_at: number | null;
  last_received_at: number | null;
  created_at: number;
}

// Slot state for a single slot
export interface SlotState {
  lastSentAt: number | null;
  lastReceivedAt: number | null;
}

// API request/response types
export interface PairRequest {
  code?: string;
  deviceId: string;
  slot?: 1 | 2;
}

export interface PairResponse {
  ok: boolean;
  slot?: 1 | 2;
  pairCode?: string;
  slots?: { 1: boolean; 2: boolean };
  error?: string;
  // Legacy fields for backward compatibility
  success?: boolean;
  paired?: boolean;
  waiting?: boolean;
}

export interface ChompResponse {
  success: boolean;
  ovenSeconds?: number;
  remainingSeconds?: number;
  error?: string;
  slot?: 1 | 2;
}

export interface StatusResponse {
  state: 'cooling' | 'oven';
  ovenRemainingSeconds: number;
  lastChompRelative: string;
  serverNow?: number;
  lastSentAt?: number | null;
  lastReceivedAt?: number | null;
  slot?: 1 | 2;
}

export interface SubscribeRequest {
  deviceId: string;
  subscription: PushSubscriptionJSON;
}

export interface MeResponse {
  paired: boolean;
  ovenRemainingSeconds: number;
  hasPartner: boolean;
  // New slot-aware fields
  serverNow?: number;
  slots?: { 1: boolean; 2: boolean };
  hasPartnerBySlot?: { 1?: boolean; 2?: boolean };
  stateBySlot?: {
    1?: SlotState;
    2?: SlotState;
  };
}

// Cloudflare D1 types
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta?: object;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}
