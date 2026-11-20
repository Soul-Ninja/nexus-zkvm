import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Redacts any HTTP(S) URL in a string to protect secrets in logs, terminal output, and databases.
 */
export function redactUrls(str: string): string {
  if (!str) return "";
  return str.replace(/https?:\/\/[^\s"'`<>]+/gi, "<redacted-url>");
}

/**
 * Checks if a URL points strictly to loopback (127.0.0.1 or localhost).
 */
export function isLoopbackUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

/**
 * Guard that strictly refuses any write / send operation directed at a non-loopback URL.
 */
export function assertLoopbackUrl(urlStr: string): void {
  if (!isLoopbackUrl(urlStr)) {
    throw new Error(`Remote write prohibited: ${redactUrls(urlStr)} is not loopback (127.0.0.1 / localhost)`);
  }
}

/**
 * Resolves the kill switch flag file path.
 */
export function getKillSwitchPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env.NEXUS_KILL_PATH) return process.env.NEXUS_KILL_PATH;
  return path.join(os.homedir(), ".nexus", "KILL");
}

/**
 * Checks if the kill switch flag file exists.
 */
export function checkKillSwitch(overridePath?: string): boolean {
  const p = getKillSwitchPath(overridePath);
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Throws if the kill switch is active.
 */
export function assertKillSwitch(overridePath?: string): void {
  if (checkKillSwitch(overridePath)) {
    throw new Error("KILL_SWITCH");
  }
}

/**
 * Loads the archive RPC URL from environment.
 */
export function getArbitrumRpcUrl(): string {
  const url = process.env.ARBITRUM_RPC_URL;
  if (!url) {
    throw new Error("ARBITRUM_RPC_URL environment variable is required");
  }
  return url;
}
