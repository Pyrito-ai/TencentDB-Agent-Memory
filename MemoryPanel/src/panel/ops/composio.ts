import { createHash } from "node:crypto";
import { z } from "zod";
import { OpsError, type MailProvider, type Thread } from "./types.js";

const API = "https://backend.composio.dev/api/v3.1";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const mailbox = z
  .string()
  .email()
  .max(254)
  .regex(/^[^\s<>\r\n]+@[^\s<>\r\n]+$/);
export const draftSchema = z
  .object({
    to: mailbox,
    subject: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    body: z.string().min(1).max(30000),
  })
  .strict();
const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const cleanHeader = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\r\n\x00]/g, " ").slice(0, 1000) : "";
export function emailAddress(value: string): string {
  const candidate = value.match(/<([^<>]+)>/)?.[1] ?? value.trim();
  return mailbox.safeParse(candidate).success ? candidate : "";
}
function encodedHeader(value: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`)
    .join("\r\n ");
}
export function replyMime(
  thread: Thread,
  draft: { to: string; subject: string; body: string },
  from: string,
): string {
  draftSchema.parse(draft);
  mailbox.parse(from);
  const messageId = /^<[^<>\s]+>$/.test(thread.messageId)
    ? thread.messageId
    : "";
  const references = (thread.references + " " + messageId)
    .split(/\s+/)
    .filter((v) => /^<[^<>\s]+>$/.test(v))
    .slice(-15);
  const body =
    Buffer.from(draft.body.replace(/\r?\n/g, "\r\n"))
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${draft.to}`,
      `Subject: ${encodedHeader(draft.subject)}`,
      ...(messageId ? [`In-Reply-To: ${messageId}`] : []),
      ...(references.length ? [`References: ${references.join("\r\n ")}`] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n"),
  ).toString("base64url");
}

type Part = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: Part[];
};
function plainBody(part: Part, depth = 0): string {
  if (depth > 10 || part.filename) return "";
  if (part.mimeType === "text/plain" && part.body?.data)
    return Buffer.from(part.body.data.slice(0, 100000), "base64url")
      .toString("utf8")
      .slice(0, 16000);
  return (part.parts || [])
    .slice(0, 30)
    .map((p) => plainBody(p, depth + 1))
    .filter(Boolean)
    .join("\n")
    .slice(0, 16000);
}

/** Fixed endpoints only. Neither clients nor model output can select a URL, tool, account or token. */
export class ComposioGmail implements MailProvider {
  constructor(
    private key: string,
    private authConfig: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call(
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    let response: Response;
    try {
      response = await this.request(API + route, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { "x-api-key": this.key, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error("upstream");
      // Gmail can include large MIME payloads; do not log the response or provider errors.
      const text = await response.text();
      if (text.length > 8_000_000) throw new Error("size");
      return JSON.parse(text);
    } catch {
      throw new OpsError(
        502,
        "The email service could not confirm this operation.",
      );
    }
  }
  async connect(user: string, callback: string) {
    const config = await this.call(
      `/auth_configs/${encodeURIComponent(this.authConfig)}`,
    );
    if (
      config.toolkit?.slug !== "gmail" ||
      config.is_composio_managed !== true ||
      config.status !== "ENABLED"
    )
      throw new OpsError(
        503,
        "A managed Gmail authentication configuration is required.",
      );
    const result = await this.call("/connected_accounts/link", "POST", {
      auth_config_id: this.authConfig,
      user_id: user,
      callback_url: callback,
      experimental: { account_type: "PRIVATE" },
    });
    let url: URL;
    try {
      url = new URL(result.redirect_url);
    } catch {
      throw new OpsError(502, "Invalid authorization link.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["connect.composio.dev", "backend.composio.dev"].includes(url.host)
    )
      throw new OpsError(502, "Invalid authorization link.");
    return {
      accountId: idSchema.parse(result.connected_account_id),
      url: url.toString(),
    };
  }
  async complete(user: string, sessionUri: string) {
    const result = await this.call(
      "/connected_accounts/complete_auth",
      "POST",
      { user_id: user, session_uri: sessionUri },
    );
    return {
      accountId: idSchema.parse(result.connected_account_id),
      toolkit: z.string().parse(result.toolkit_slug),
    };
  }
  async account(id: string) {
    const account = await this.call(
      `/connected_accounts/${encodeURIComponent(idSchema.parse(id))}`,
    );
    // Explicit projection: account.state/data/params may contain credentials and must never escape this adapter.
    return {
      user: String(account.user_id ?? ""),
      toolkit: String(account.toolkit?.slug ?? ""),
      status:
        account.is_disabled === true ||
        account.auth_config?.is_disabled === true
          ? "DISABLED"
          : String(account.status ?? ""),
      private: account.experimental?.account_type === "PRIVATE",
    };
  }
  private async proxy(id: string, path: string, body?: unknown): Promise<any> {
    idSchema.parse(id);
    const response = await this.call("/tools/execute/proxy", "POST", {
      connected_account_id: id,
      endpoint: GMAIL + path,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body }),
    });
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !response.data ||
      typeof response.data !== "object"
    )
      throw new OpsError(502, "Gmail could not confirm this operation.");
    return response.data;
  }
  async profile(id: string) {
    return mailbox.parse((await this.proxy(id, "/profile")).emailAddress);
  }
  async search(id: string, query: string, cursor?: string) {
    const params = new URLSearchParams({ q: query, maxResults: "5" });
    if (cursor) params.set("pageToken", cursor);
    const data = await this.proxy(id, "/threads?" + params);
    return {
      ids: z
        .array(z.object({ id: idSchema }))
        .max(5)
        .parse(data.threads || [])
        .map((t) => t.id),
      cursor: z.string().max(2000).optional().parse(data.nextPageToken),
    };
  }
  async thread(id: string, thread: string): Promise<Thread> {
    const data = await this.proxy(
      id,
      `/threads/${encodeURIComponent(idSchema.parse(thread))}?format=full`,
    );
    if (
      data.id !== thread ||
      !Array.isArray(data.messages) ||
      !data.messages.length
    )
      throw new OpsError(502, "Email thread is unavailable.");
    const messages = data.messages.slice(-8);
    const latest = messages.at(-1);
    const header = (msg: any, name: string) =>
      cleanHeader(
        msg.payload?.headers?.find(
          (h: any) => String(h.name).toLowerCase() === name,
        )?.value,
      );
    return {
      id: thread,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(data.messages.map((m: any) => m.id)))
        .digest("hex"),
      subject: header(latest, "subject"),
      from: header(latest, "from"),
      replyTo: emailAddress(
        header(latest, "reply-to") || header(latest, "from"),
      ),
      messageId: header(latest, "message-id"),
      references: header(latest, "references"),
      date: header(latest, "date"),
      text: messages
        .map(
          (m: any) =>
            `From: ${header(m, "from")}\nDate: ${header(m, "date")}\n${plainBody(m.payload || {}) || cleanHeader(m.snippet)}`,
        )
        .join("\n\n")
        .slice(-24000),
    };
  }
  async send(
    id: string,
    thread: Thread,
    draft: { to: string; subject: string; body: string },
    from: string,
  ) {
    const result = await this.proxy(id, "/messages/send", {
      threadId: idSchema.parse(thread.id),
      raw: replyMime(thread, draft, from),
    });
    return idSchema.parse(result.id);
  }
  async revoke(id: string) {
    await this.call(
      `/connected_accounts/${encodeURIComponent(idSchema.parse(id))}/revoke`,
      "POST",
    );
  }
}
