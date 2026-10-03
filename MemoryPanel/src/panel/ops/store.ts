import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { OpsError, type Owner, type RecordValue } from "./types.js";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** No mailbox content or background-job credentials are stored in plaintext. */
export class OpsStore {
  private db: InstanceType<typeof DatabaseSync>;
  private key: Buffer;
  private leases = new Map<string, string>();
  constructor(root: string, key: string) {
    if (!/^[a-f\d]{64}$/i.test(key))
      throw new Error(
        "PYRITO_OPS_ENCRYPTION_KEY must contain 32 random bytes in hex.",
      );
    this.key = Buffer.from(key, "hex");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const file = path.join(root, "private-ops.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(scope TEXT,kind TEXT,id TEXT,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,kind,id));
      CREATE TABLE IF NOT EXISTS leases(scope TEXT PRIMARY KEY,token TEXT,expires INTEGER);`);
  }
  scope(owner: Owner) {
    return createHash("sha256")
      .update(JSON.stringify([owner.instance, owner.team, owner.user]))
      .digest("hex");
  }
  private seal(aad: string, value: unknown): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  private open<T>(aad: string, value: string): T {
    const b = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(
        "utf8",
      ),
    ) as T;
  }
  get<T>(owner: Owner, kind: string, id: string): RecordValue<T> | undefined {
    const scope = this.scope(owner);
    const row = this.db
      .prepare(
        "SELECT revision,body FROM records WHERE scope=? AND kind=? AND id=?",
      )
      .get(scope, kind, id);
    return row
      ? {
          id,
          revision: Number(row.revision),
          value: this.open<T>(`${scope}:${kind}:${id}`, String(row.body)),
        }
      : undefined;
  }
  require<T>(owner: Owner, kind: string, id: string): RecordValue<T> {
    const record = this.get<T>(owner, kind, id);
    if (!record) throw new OpsError(404, "Item not found.");
    return record;
  }
  list<T>(owner: Owner, kind: string): RecordValue<T>[] {
    return this.db
      .prepare(
        "SELECT id FROM records WHERE scope=? AND kind=? ORDER BY rowid DESC",
      )
      .all(this.scope(owner), kind)
      .map((row) => this.require<T>(owner, kind, String(row.id)));
  }
  put<T>(
    owner: Owner,
    kind: string,
    id: string,
    value: T,
    revision = 0,
  ): RecordValue<T> {
    this.assertLease(owner);
    const scope = this.scope(owner),
      body = this.seal(`${scope}:${kind}:${id}`, value);
    const result =
      revision === 0
        ? this.db
            .prepare("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)")
            .run(scope, kind, id, 1, body)
        : this.db
            .prepare(
              "UPDATE records SET revision=revision+1,body=? WHERE scope=? AND kind=? AND id=? AND revision=?",
            )
            .run(body, scope, kind, id, revision);
    if (Number(result.changes) !== 1)
      throw new OpsError(
        409,
        "This item changed. Refresh before trying again.",
      );
    return { id, revision: revision + 1, value };
  }
  /** Only the internal scheduler can enumerate owners. Owner identities are encrypted too. */
  owners(): Owner[] {
    return this.db
      .prepare("SELECT scope,id,body FROM records WHERE kind='owner'")
      .all()
      .map((row) =>
        this.open<Owner>(`${row.scope}:owner:${row.id}`, String(row.body)),
      );
  }
  remember(owner: Owner) {
    if (!this.get(owner, "owner", "identity"))
      this.put(owner, "owner", "identity", owner);
  }
  async exclusive<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
    const scope = this.scope(owner),
      token = randomUUID();
    const result = this.db
      .prepare(
        `INSERT INTO leases VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE leases.expires < ?`,
      )
      .run(scope, token, Date.now() + 120_000, Date.now());
    if (Number(result.changes) !== 1)
      throw new OpsError(
        409,
        "An Ops operation is already running. Try again when it finishes.",
      );
    this.leases.set(scope, token);
    const renew = setInterval(() => {
      this.db
        .prepare(
          "UPDATE leases SET expires=? WHERE scope=? AND token=? AND expires>?",
        )
        .run(Date.now() + 120_000, scope, token, Date.now());
    }, 30000);
    renew.unref();
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      this.leases.delete(scope);
      this.db
        .prepare("DELETE FROM leases WHERE scope=? AND token=?")
        .run(scope, token);
    }
  }
  assertLease(owner: Owner) {
    const scope = this.scope(owner),
      token = this.leases.get(scope);
    if (
      token &&
      !this.db
        .prepare(
          "SELECT scope FROM leases WHERE scope=? AND token=? AND expires>?",
        )
        .get(scope, token, Date.now())
    )
      throw new OpsError(
        409,
        "The Ops operation lease expired. Refresh before continuing.",
      );
  }
  busy(owner: Owner): boolean {
    return !!this.db
      .prepare("SELECT scope FROM leases WHERE scope=? AND expires>?")
      .get(this.scope(owner), Date.now());
  }
  close() {
    this.db.close();
  }
}
