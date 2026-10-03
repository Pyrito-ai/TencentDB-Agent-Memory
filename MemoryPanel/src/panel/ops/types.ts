export type Owner = { instance: string; team: string; user: string };
export type Connection = {
  providerUser: string;
  accountId: string;
  status: "pending" | "active" | "disconnected";
  email: string;
  revokePending?: boolean;
  identityVerified?: boolean;
};
export type Thread = {
  id: string;
  fingerprint: string;
  subject: string;
  from: string;
  replyTo: string;
  messageId: string;
  references: string;
  text: string;
  date: string;
};
export type MarkdownNote = {
  markdown: string;
  trashed: boolean;
  createdAt: number;
  /** Private provenance for Gmail deduplication; never part of the board response. */
  source?: { connectionId: string; threadId: string; fingerprint: string };
};
/** Existing encrypted records remain readable without a storage migration. */
export type LegacyEmailNote = {
  connectionId: string;
  thread: Thread;
  comment: string;
  to: string;
  subject: string;
  body: string;
  status: "draft" | "sending" | "sent" | "unknown";
  trashed: boolean;
  createdAt: number;
  sentId?: string;
};
export type Note = MarkdownNote | LegacyEmailNote;
export type PublicNote = Pick<
  MarkdownNote,
  "markdown" | "trashed" | "createdAt"
> & {
  id: string;
  revision: number;
};
export const isLegacyEmailNote = (note: Note): note is LegacyEmailNote =>
  !("markdown" in note) && "thread" in note && "status" in note;
export type Routine = {
  connectionId: string;
  name: string;
  query: string;
  instruction: string;
  intervalMinutes: number;
  enabled: boolean;
  credential: string;
  nextRun: number;
  lastRun?: number;
  lastError?: string;
  cursor?: string;
};
export type RecordValue<T> = { id: string; revision: number; value: T };
export class OpsError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
export interface MailProvider {
  complete(
    user: string,
    sessionUri: string,
  ): Promise<{ accountId: string; toolkit: string }>;
  connect(
    user: string,
    callback: string,
  ): Promise<{ accountId: string; url: string }>;
  account(id: string): Promise<{
    user: string;
    toolkit: string;
    status: string;
    private: boolean;
  }>;
  profile(id: string): Promise<string>;
  search(
    id: string,
    query: string,
    cursor?: string,
  ): Promise<{ ids: string[]; cursor?: string }>;
  thread(id: string, thread: string): Promise<Thread>;
  send(
    id: string,
    thread: Thread,
    draft: { to: string; subject: string; body: string },
    from: string,
  ): Promise<string>;
  revoke(id: string): Promise<void>;
}
export type DraftModel = (
  instruction: string,
  thread: Thread,
) => Promise<{ relevant: boolean; markdown: string }>;
