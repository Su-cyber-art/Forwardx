import { Request } from "express";
import * as db from "./db";

export async function resolvePanelUrl(req: Request): Promise<string> {
  const configured = (await db.getSetting("panelPublicUrl")) || "";
  if (configured && /^https?:\/\//.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}
