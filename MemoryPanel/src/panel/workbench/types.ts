export interface Message {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  created: number;
  status?: "pending" | "sent" | "failed";
}
export interface FileEntry {
  path: string;
  status: string;
}
export interface WorkspaceSnapshot {
  files: FileEntry[];
  branch: string;
  base: string;
  diff: string;
  snapshot: string;
  truncated: boolean;
  notice?: string;
}
export interface FileContent {
  path: string;
  content: string;
}
export interface WorkerReview {
  decision: "approved" | "changes_requested";
  comment: string;
  snapshot: string;
  created: number;
  stale?: boolean;
}
