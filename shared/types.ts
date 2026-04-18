// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  name: string | null;
  tmux_session: string | null;
  tmux_window_index: string | null;
  tmux_window_name: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  name: string | null;
  tmux_session: string | null;
  tmux_window_index: string | null;
  tmux_window_name: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  // S2: per-peer auth token returned at registration. Required as
  // X-Peer-Token header on every subsequent broker call.
  token: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetNameRequest {
  id: PeerId;
  // Empty string clears the name.
  name: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

// /broadcast-message — fanout send by scope. At least one filter is required
// to avoid unbounded global broadcast. Filters AND together.
export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  tmux_session?: string | null;
  git_root?: string | null;
  name_like?: string | null;     // case-insensitive substring on peer name
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  // Renamed from `peer_id` to `id` for consistency with sibling request types
  // (HeartbeatRequest, SetSummaryRequest, PollMessagesRequest all use `id`).
  id: PeerId;
  // Non-empty list of message IDs to acknowledge as delivered to this peer.
  ids: number[];
  // Delivery-path label forwarded to the broker latency log ("piggyback" via
  // tool-response drain, or "check_messages" via explicit poll). Optional for
  // backward compat with older servers; broker logs "unknown" when absent.
  via?: string;
}
