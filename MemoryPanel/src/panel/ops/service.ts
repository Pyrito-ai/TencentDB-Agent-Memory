import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PanelDeps } from "../panel-deps.js";
import type { MetaCallContext } from "../kernel/types.js";
import { resolveCallerUserId } from "../http/routes/knowledge/common.js";
import { draftSchema, emailAddress } from "./composio.js";
import { OpsStore } from "./store.js";
import { markdownSchema, noteModelResult } from "./model.js";
import {
  OpsError,
  isLegacyEmailNote,
  type Owner,
  type Connection,
  type Note,
  type LegacyEmailNote,
  type PublicNote,
  type Routine,
  type MailProvider,
  type DraftModel,
  type RecordValue,
  type Thread,
} from "./types.js";
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive();
const identifier = z.object({ id }).strict();
const noteRevision = z.object({ id, revision }).strict();
const noteSave = z
  .object({
    markdown: markdownSchema,
    id: id.optional(),
    revision: revision.optional(),
  })
  .strict()
  .refine((value) => !!value.id === (value.revision !== undefined), {
    message: "An existing note needs both its ID and revision.",
  });
const routineFields = {
  connectionId: id,
  name: z.string().trim().min(1).max(100),
  query: z.string().trim().min(1).max(1000),
  instruction: z.string().trim().min(1).max(4000),
  intervalMinutes: z.number().int().min(15).max(10080),
  enabled: z.boolean(),
};
const searchSchema = z
  .object({
    connectionId: id,
    query: z.string().min(1).max(1000),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
const threadSchema = z.object({ connectionId: id, threadId: id }).strict();
const hash = (parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function legacyMarkdown(note: LegacyEmailNote): string {
  const subject = note.thread.subject || note.subject || "Email note";
  const status = {
    draft: "",
    sent: "Reply sent.",
    sending:
      "Sending was started. Check Gmail Sent before sending another reply.",
    unknown:
      "Send result uncertain. Check Gmail Sent before sending another reply.",
  }[note.status];
  const suggestion =
    note.status === "draft" && note.body
      ? "Suggested reply:\n\n" +
        note.body
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n")
      : "";
  return [
    `## ${subject.replace(/[\r\n]+/g, " ")}`,
    note.comment,
    suggestion,
    status,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export async function opsOwner(
  deps: PanelDeps,
  ctx: MetaCallContext,
  team: string,
): Promise<Owner> {
  const user = await resolveCallerUserId(deps, ctx);
  if (!user)
    throw new OpsError(401, "Sign in to access your private Ops board.");
  const membership = await deps.metaKernel.invoke(
    "team-member/get",
    { team_id: team, user_id: user },
    ctx,
  );
  if (
    membership.code !== 0 ||
    (membership.data as { status?: string } | null)?.status !== "active"
  )
    throw new OpsError(403, "Active workspace membership required.");
  return { instance: ctx.instanceId, team, user };
}

export class OpsService {
  private ticking = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly store: OpsStore,
    private provider: MailProvider | undefined,
    private deps: PanelDeps,
    private callback: string,
    private model?: DraftModel,
  ) {}
  private mail(): MailProvider {
    if (!this.provider)
      throw new OpsError(
        503,
        "Gmail connections have not been configured on this server.",
      );
    return this.provider;
  }
  private async authorize(owner: Owner, credential: string) {
    const instance = this.deps.instanceRegistry.resolve(owner.instance);
    const actual = await opsOwner(
      this.deps,
      {
        instanceId: owner.instance,
        userKey: credential,
        gatewayEndpoint: instance.gateway_endpoint,
        gatewayApiKey: instance.api_key,
      },
      owner.team,
    );
    if (actual.user !== owner.user)
      throw new OpsError(
        403,
        "The saved authorization no longer belongs to this account.",
      );
  }
  private async connection(owner: Owner, connectionId: string, active = true) {
    this.store.assertLease(owner);
    const record = this.store.require<Connection>(
      owner,
      "connection",
      connectionId,
    );
    if (record.value.status === "disconnected")
      throw new OpsError(409, "This Gmail connection is disconnected.");
    const account = await this.mail().account(record.value.accountId);
    if (
      account.user !== record.value.providerUser ||
      account.toolkit !== "gmail" ||
      !account.private
    )
      throw new OpsError(
        403,
        "The email connection does not belong to this private account.",
      );
    if (
      active &&
      (account.status !== "ACTIVE" || !record.value.identityVerified)
    )
      throw new OpsError(409, "Complete or renew Gmail authorization first.");
    return { record, account };
  }
  private publicNote(record: RecordValue<Note>): PublicNote {
    const note = record.value;
    // Explicit projection keeps old snapshots and private provenance out of every response.
    const markdown = isLegacyEmailNote(note)
      ? legacyMarkdown(note)
      : note.markdown;
    return {
      id: record.id,
      revision: record.revision,
      markdown,
      trashed: note.trashed,
      createdAt: note.createdAt,
    };
  }
  state(owner: Owner) {
    return {
      boardReady: true,
      configured: !!this.provider,
      draftReady: !!this.provider && !!this.model,
      busy: this.store.busy(owner),
      connections: this.store
        .list<Connection>(owner, "connection")
        .map(({ id, revision, value }) => ({
          id,
          revision,
          email: value.email,
          status: value.status,
          revokePending: !!value.revokePending,
        })),
      notes: this.store
        .list<Note>(owner, "note")
        .map((note) => this.publicNote(note)),
      routines: this.store
        .list<Routine>(owner, "routine")
        .map(
          ({ id, revision, value: { credential: _credential, ...value } }) => ({
            id,
            revision,
            ...value,
          }),
        ),
    };
  }
  async perform(
    owner: Owner,
    credential: string,
    operation: string,
    input: unknown,
  ): Promise<unknown> {
    await this.authorize(owner, credential);
    if (operation === "list") {
      z.object({}).strict().parse(input);
      return this.state(owner);
    }
    if (operation === "note-get") {
      const b = noteRevision.parse(input);
      const record = this.store.require<Note>(owner, "note", b.id);
      if (record.revision !== b.revision || record.value.trashed)
        throw new OpsError(
          409,
          "This note changed or was dismissed. Refresh the board before discussing it.",
        );
      return this.publicNote(record);
    }
    return this.store.exclusive(owner, async () => {
      switch (operation) {
        case "note-save": {
          const b = noteSave.parse(input);
          const prior = b.id
            ? this.store.require<Note>(owner, "note", b.id)
            : undefined;
          if (prior && (prior.revision !== b.revision || prior.value.trashed))
            throw new OpsError(
              409,
              "This note changed or was dismissed. Refresh and restore it before editing.",
            );
          const note = this.store.put<Note>(
            owner,
            "note",
            prior?.id || randomUUID(),
            {
              // Preserve legacy data privately; adding Markdown retires its send/edit path.
              ...prior?.value,
              markdown: b.markdown,
              trashed: false,
              createdAt: prior?.value.createdAt ?? Date.now(),
            },
            prior?.revision,
          );
          return this.publicNote(note);
        }
        case "connect": {
          z.object({}).strict().parse(input);
          this.mail();
          if (
            this.store
              .list<Connection>(owner, "connection")
              .filter((c) => c.value.status !== "disconnected").length >= 5
          )
            throw new OpsError(
              409,
              "Disconnect an existing account before adding another.",
            );
          this.store.remember(owner);
          let identity = this.store.get<{ user: string }>(
            owner,
            "provider",
            "identity",
          );
          if (!identity)
            identity = this.store.put(owner, "provider", "identity", {
              user: `pyrito_${randomUUID()}`,
            });
          const result = await this.mail().connect(
            identity.value.user,
            this.callback,
          );
          const connectionId = randomUUID();
          this.store.put<Connection>(owner, "connection", connectionId, {
            providerUser: identity.value.user,
            accountId: result.accountId,
            email: "",
            status: "pending",
          });
          return { id: connectionId, url: result.url };
        }
        case "complete": {
          const { sessionUri } = z
            .object({ sessionUri: z.string().min(1).max(4096) })
            .strict()
            .parse(input);
          const identity = this.store.require<{ user: string }>(
            owner,
            "provider",
            "identity",
          );
          const result = await this.mail().complete(
            identity.value.user,
            sessionUri,
          );
          if (result.toolkit !== "gmail")
            throw new OpsError(403, "This authorization is not for Gmail.");
          const record = this.store
            .list<Connection>(owner, "connection")
            .find(
              (c) =>
                c.value.accountId === result.accountId &&
                c.value.status !== "disconnected",
            );
          if (!record)
            throw new OpsError(
              404,
              "No pending connection belongs to this account.",
            );
          const verified = await this.connection(owner, record.id, false);
          if (verified.account.status !== "ACTIVE")
            throw new OpsError(409, "Gmail authorization is not active yet.");
          await this.authorize(owner, credential);
          const email = await this.mail().profile(result.accountId);
          this.store.put(
            owner,
            "connection",
            record.id,
            {
              ...record.value,
              email,
              status: "active",
              identityVerified: true,
            },
            record.revision,
          );
          return { connected: true, email };
        }
        case "refresh": {
          const { id } = identifier.parse(input);
          const { record, account } = await this.connection(owner, id, false);
          const email =
            account.status === "ACTIVE" && record.value.identityVerified
              ? await this.mail().profile(record.value.accountId)
              : "";
          this.store.put(
            owner,
            "connection",
            id,
            { ...record.value, status: email ? "active" : "pending", email },
            record.revision,
          );
          if (account.status === "ACTIVE" && !record.value.identityVerified)
            throw new OpsError(
              409,
              "Finish authorization from the returning Google tab. If no verification tab appeared, the Composio callback verifier must be configured.",
            );
          return { status: email ? "active" : "pending", email };
        }
        case "disconnect": {
          const { id } = identifier.parse(input);
          const record = this.store.require<Connection>(
            owner,
            "connection",
            id,
          );
          // Disable locally before contacting Composio; failed revocation never restores access.
          const disabled = this.store.put(
            owner,
            "connection",
            id,
            {
              ...record.value,
              status: "disconnected" as const,
              revokePending: true,
            },
            record.revision,
          );
          for (const routine of this.store
            .list<Routine>(owner, "routine")
            .filter((r) => r.value.connectionId === id))
            this.store.put(
              owner,
              "routine",
              routine.id,
              {
                ...routine.value,
                enabled: false,
                credential: "",
                lastError: "Gmail disconnected.",
              },
              routine.revision,
            );
          const remote = await this.mail().account(record.value.accountId);
          if (
            remote.user !== record.value.providerUser ||
            remote.toolkit !== "gmail" ||
            !remote.private
          )
            throw new OpsError(
              403,
              "Gmail is disabled here. The provider connection could not be verified for revocation.",
            );
          await this.mail().revoke(record.value.accountId);
          this.store.put(
            owner,
            "connection",
            id,
            { ...disabled.value, revokePending: false },
            disabled.revision,
          );
          return { disconnected: true };
        }
        case "search": {
          const b = searchSchema.parse(input),
            { record } = await this.connection(owner, b.connectionId);
          return this.mail().search(record.value.accountId, b.query, b.cursor);
        }
        case "thread": {
          const b = threadSchema.parse(input),
            { record } = await this.connection(owner, b.connectionId);
          return this.mail().thread(record.value.accountId, b.threadId);
        }
        case "prepare": {
          const b = threadSchema
            .extend({ instruction: z.string().min(1).max(4000) })
            .parse(input);
          const { record } = await this.connection(owner, b.connectionId);
          const thread = await this.mail().thread(
            record.value.accountId,
            b.threadId,
          );
          const note = await this.prepare(
            owner,
            credential,
            b.connectionId,
            record.value,
            thread,
            b.instruction,
          );
          return { note: note ? this.publicNote(note) : null };
        }
        case "edit": {
          const b = noteRevision.extend(draftSchema.shape).parse(input);
          const record = this.store.require<Note>(owner, "note", b.id);
          if (!isLegacyEmailNote(record.value))
            throw new OpsError(
              409,
              "Markdown notes do not contain an email draft.",
            );
          if (record.value.status !== "draft" || record.value.trashed)
            throw new OpsError(409, "Only an active draft can be edited.");
          const note = this.store.put(
            owner,
            "note",
            b.id,
            { ...record.value, to: b.to, subject: b.subject, body: b.body },
            b.revision,
          );
          return this.publicNote(note);
        }
        case "trash": {
          const b = noteRevision.extend({ trashed: z.boolean() }).parse(input);
          const record = this.store.require<Note>(owner, "note", b.id);

          return this.publicNote(
            this.store.put(
              owner,
              "note",
              b.id,
              {
                ...record.value,
                ...(isLegacyEmailNote(record.value) &&
                record.value.status === "sending"
                  ? { status: "unknown" as const }
                  : {}),
                trashed: b.trashed,
              },
              b.revision,
            ),
          );
        }
        case "send": {
          const b = noteRevision
            .extend({ approve: z.literal(true) })
            .parse(input);
          const saved = this.store.require<Note>(owner, "note", b.id);
          if (!isLegacyEmailNote(saved.value))
            throw new OpsError(409, "Markdown notes cannot be sent as email.");
          let record: RecordValue<LegacyEmailNote> = {
            ...saved,
            value: saved.value,
          };
          if (
            record.revision !== b.revision ||
            record.value.status !== "draft" ||
            record.value.trashed
          )
            throw new OpsError(
              409,
              "This draft changed or was already submitted. Refresh and review it again.",
            );
          const draft = draftSchema.parse({
            to: record.value.to,
            subject: record.value.subject,
            body: record.value.body,
          });
          const { record: connection } = await this.connection(
            owner,
            record.value.connectionId,
          );
          const thread = await this.mail().thread(
            connection.value.accountId,
            record.value.thread.id,
          );
          if (thread.fingerprint !== record.value.thread.fingerprint)
            throw new OpsError(
              409,
              "This email thread has new messages. Review and reply in Gmail.",
            );
          await this.authorize(owner, credential);
          record = this.store.put(
            owner,
            "note",
            b.id,
            { ...record.value, status: "sending" },
            b.revision,
          );
          try {
            const sentId = await this.mail().send(
              connection.value.accountId,
              thread,
              draft,
              connection.value.email,
            );
            return this.publicNote(
              this.store.put(
                owner,
                "note",
                b.id,
                { ...record.value, status: "sent", sentId },
                record.revision,
              ),
            );
          } catch {
            this.store.put(
              owner,
              "note",
              b.id,
              { ...record.value, status: "unknown" },
              record.revision,
            );
            throw new OpsError(
              502,
              "Send result is uncertain. Check Gmail Sent. This note will not send again automatically.",
            );
          }
        }
        case "routine-save": {
          const b = z
            .object({
              ...routineFields,
              id: id.optional(),
              revision: revision.optional(),
            })
            .strict()
            .parse(input);
          const prior = b.id
            ? this.store.require<Routine>(owner, "routine", b.id)
            : undefined;
          if (prior && b.revision !== prior.revision)
            throw new OpsError(409, "Routine changed. Refresh it first.");
          if (b.enabled && !this.model)
            throw new OpsError(
              503,
              "Configure the coordinator model before enabling routines.",
            );
          await this.connection(owner, b.connectionId);
          if (!prior && this.store.list(owner, "routine").length >= 20)
            throw new OpsError(409, "You can save up to 20 email routines.");
          this.store.remember(owner);
          const { id: ignoredId, revision: ignoredRevision, ...fields } = b;
          this.store.put<Routine>(
            owner,
            "routine",
            prior?.id || randomUUID(),
            {
              ...fields,
              credential: b.enabled ? credential : "",
              nextRun: Date.now() + b.intervalMinutes * 60000,
            },
            prior?.revision,
          );
          return { saved: true };
        }
        case "routine-toggle": {
          const b = noteRevision.extend({ enabled: z.boolean() }).parse(input);
          const prior = this.store.require<Routine>(owner, "routine", b.id);
          if (b.enabled) {
            if (!this.model)
              throw new OpsError(
                503,
                "Configure the coordinator model before enabling routines.",
              );
            await this.connection(owner, prior.value.connectionId);
          }
          this.store.put(
            owner,
            "routine",
            b.id,
            {
              ...prior.value,
              enabled: b.enabled,
              credential: b.enabled ? credential : "",
              nextRun: Date.now() + prior.value.intervalMinutes * 60000,
            },
            b.revision,
          );
          return { enabled: b.enabled };
        }
        case "routine-run": {
          const b = identifier.parse(input);
          const routine = this.store.require<Routine>(owner, "routine", b.id);
          await this.run(owner, credential, routine);
          return { completed: true };
        }
        default:
          throw new OpsError(404, "Operation not found.");
      }
    });
  }
  private async prepare(
    owner: Owner,
    credential: string,
    connectionId: string,
    connection: Connection,
    thread: Thread,
    instruction: string,
  ) {
    if (!this.model)
      throw new OpsError(
        503,
        "Configure the coordinator model to prepare email notes.",
      );
    const noteId = hash([connectionId, thread.id, thread.fingerprint]);
    const existing = this.store.get<Note>(owner, "note", noteId);
    if (existing) return existing; // Includes dismissed/sent notes: repeat runs cannot recreate them.
    const seenId = hash([noteId, instruction]);
    if (this.store.get(owner, "seen", seenId)) return undefined;
    if (
      emailAddress(thread.from).toLowerCase() === connection.email.toLowerCase()
    )
      return undefined;
    const result = noteModelResult.safeParse(
      await this.model(instruction, thread),
    );
    if (!result.success)
      throw new OpsError(
        502,
        "The coordinator could not prepare a valid Markdown note.",
      );
    const decision = result.data;
    await this.authorize(owner, credential);
    await this.connection(owner, connectionId);
    if (!decision.relevant) {
      this.store.put(owner, "seen", seenId, { reviewed: Date.now() });
      return undefined;
    }
    return this.store.put<Note>(owner, "note", noteId, {
      source: {
        connectionId,
        threadId: thread.id,
        fingerprint: thread.fingerprint,
      },
      markdown: decision.markdown,
      trashed: false,
      createdAt: Date.now(),
    });
  }
  private async run(
    owner: Owner,
    credential: string,
    record: RecordValue<Routine>,
  ) {
    const routine = record.value;
    let cursor = routine.cursor;
    try {
      if (!this.model)
        throw new OpsError(503, "Coordinator model is not configured.");
      await this.authorize(owner, credential);
      const { record: connection } = await this.connection(
        owner,
        routine.connectionId,
      );
      const page = await this.mail().search(
        connection.value.accountId,
        routine.query,
        routine.cursor,
      );
      for (const threadId of page.ids) {
        if (this.stopped)
          throw new OpsError(
            503,
            "Server is stopping; this check will resume later.",
          );
        await this.authorize(owner, credential);
        await this.connection(owner, routine.connectionId);
        const thread = await this.mail().thread(
          connection.value.accountId,
          threadId,
        );
        await this.prepare(
          owner,
          credential,
          routine.connectionId,
          connection.value,
          thread,
          routine.instruction,
        );
      }
      cursor = page.cursor;
      this.store.put(
        owner,
        "routine",
        record.id,
        {
          ...routine,
          cursor,
          lastRun: Date.now(),
          lastError: undefined,
          nextRun: Date.now() + routine.intervalMinutes * 60000,
        },
        record.revision,
      );
    } catch (error) {
      const revoked =
        error instanceof OpsError && [401, 403].includes(error.status);
      this.store.put(
        owner,
        "routine",
        record.id,
        {
          ...routine,
          enabled: revoked ? false : routine.enabled,
          credential: revoked ? "" : routine.credential,
          lastError:
            error instanceof OpsError
              ? error.message
              : "Email check failed. No email was sent.",
          nextRun: Date.now() + routine.intervalMinutes * 60000,
        },
        record.revision,
      );
      throw error;
    }
  }
  async tick(now = Date.now()) {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const owner of this.store.owners()) {
        for (const candidate of this.store.list<Routine>(owner, "routine")) {
          if (this.stopped) return;
          if (!candidate.value.enabled || candidate.value.nextRun > now)
            continue;
          try {
            await this.store.exclusive(owner, async () => {
              // Re-read after acquiring the durable lease: another process may already have run it.
              const current = this.store.require<Routine>(
                owner,
                "routine",
                candidate.id,
              );
              if (current.value.enabled && current.value.nextRun <= now)
                await this.run(owner, current.value.credential, current);
            });
          } catch {
            /* Safe, owner-visible errors are persisted by run; no message bodies in logs. */
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.deps.logger?.warn(
          "Private Ops scheduler unavailable; check storage and encryption configuration.",
        ),
      );
    }, 30000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
