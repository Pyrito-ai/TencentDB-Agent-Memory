import path from "node:path";
import type { PanelDeps } from "../panel-deps.js";
import { ComposioGmail } from "./composio.js";
import { createDraftModel } from "./model.js";
import { OpsService } from "./service.js";
import { OpsStore } from "./store.js";

export function createOpsService(deps: PanelDeps): OpsService | undefined {
  const key = process.env.COMPOSIO_API_KEY;
  const authConfig = process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
  const encryption = process.env.PYRITO_OPS_ENCRYPTION_KEY;
  const publicUrl = process.env.PYRITO_PUBLIC_URL;
  if (!encryption || !publicUrl) return undefined;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return undefined;
  }
  if (
    !/^[a-f\d]{64}$/i.test(encryption) ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    return undefined;
  const store = new OpsStore(
    process.env.PYRITO_OPS_DATA_DIR || path.resolve("data/private-ops"),
    encryption,
  );
  return new OpsService(
    store,
    key && authConfig ? new ComposioGmail(key, authConfig) : undefined,
    deps,
    url.origin + "/#/ops",
    createDraftModel(),
  );
}
