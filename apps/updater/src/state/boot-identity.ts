import { execFile } from "node:child_process";
import {
  readFile as readFileFromDisk,
  readdir as readDirectoryFromDisk,
  readlink as readLinkFromDisk,
} from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BootProviderKind = "linux-proc" | "windows-cim";

export interface BootIdentity {
  provider: BootProviderKind;
  value: string;
}

export interface ProcessIdentityProvider {
  current(): Promise<BootIdentity>;
  processCreatedAt(pid: number): Promise<string>;
  isProcessAlive(pid: number, processCreatedAt: string): Promise<boolean>;
  listeningPid?(port: number): Promise<number | undefined>;
}

export interface PlatformBootIdentityOptions {
  platform?: NodeJS.Platform;
  readFile?: (filename: string) => Promise<string>;
  readDirectory?: (directory: string) => Promise<string[]>;
  readLink?: (filename: string) => Promise<string>;
  runPowerShell?: (script: string) => Promise<string>;
  kill?: (pid: number, signal?: number | NodeJS.Signals) => boolean;
}

export class BootIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootIdentityError";
  }
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BootIdentityError(`${field} is unavailable`);
  return normalized;
}

/**
 * Convert a CIM timestamp to a stable UTC representation. CIM may surface a
 * locale-formatted DateTime or an ISO 8601 value depending on PowerShell/WMI.
 */
export function canonicalWindowsCimTimestamp(value: string): string {
  const raw = nonEmpty(value, "Windows CIM timestamp");
  const iso = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/.exec(raw);
  if (iso) {
    const millis = (iso[2] ?? "").padEnd(3, "0").slice(0, 3);
    const fraction = iso[2] ?? "000";
    if (fraction.length > 3) return `${iso[1]}.${fraction}Z`;
    return `${iso[1]}.${millis}Z`;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed))
    throw new BootIdentityError("Windows CIM timestamp is invalid");
  return new Date(parsed).toISOString();
}

function parseLinuxProcessStart(raw: string, pid: number): string {
  const closing = raw.lastIndexOf(")");
  if (closing < 0) throw new BootIdentityError("Linux process stat is invalid");
  const fields = raw
    .slice(closing + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // The first field after the command name is stat field 3. Starttime is 22.
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime))
    throw new BootIdentityError(`Linux process ${pid} creation time is invalid`);
  return `linux-starttime:${startTime}`;
}

export class PlatformBootIdentityProvider implements ProcessIdentityProvider {
  private readonly platform: NodeJS.Platform;
  private readonly readText: (filename: string) => Promise<string>;
  private readonly readDirectory: (directory: string) => Promise<string[]>;
  private readonly readLink: (filename: string) => Promise<string>;
  private readonly powershell: (script: string) => Promise<string>;
  private readonly kill: (pid: number, signal?: number | NodeJS.Signals) => boolean;

  constructor(options: PlatformBootIdentityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.readText =
      options.readFile ?? ((filename) => readFileFromDisk(filename, "utf8"));
    this.readDirectory = options.readDirectory ?? readDirectoryFromDisk;
    this.readLink = options.readLink ?? readLinkFromDisk;
    this.powershell =
      options.runPowerShell ??
      (async (script) => {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        return stdout;
      });
    this.kill = options.kill ?? process.kill.bind(process);
  }

  async current(): Promise<BootIdentity> {
    if (this.platform === "linux") {
      try {
        const bootId = nonEmpty(
          await this.readText("/proc/sys/kernel/random/boot_id"),
          "Linux boot id",
        );
        if (!/^[a-f0-9-]{16,64}$/i.test(bootId))
          throw new BootIdentityError("Linux boot id is malformed");
        return {
          provider: "linux-proc",
          value: `linux:${bootId.toLowerCase()}`,
        };
      } catch (error) {
        if (error instanceof BootIdentityError) throw error;
        throw new BootIdentityError("Linux boot id is unavailable");
      }
    }
    if (this.platform === "win32") {
      try {
        const script = [
          "$value = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime",
          "$value.ToUniversalTime().ToString('O', [Globalization.CultureInfo]::InvariantCulture)",
        ].join("; ");
        const value = canonicalWindowsCimTimestamp(await this.powershell(script));
        return { provider: "windows-cim", value: `win32:${value}` };
      } catch (error) {
        if (error instanceof BootIdentityError) throw error;
        throw new BootIdentityError("Windows CIM boot identity is unavailable");
      }
    }
    throw new BootIdentityError(
      `Boot identity is unsupported on ${this.platform}`,
    );
  }

  async processCreatedAt(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new BootIdentityError("PID must be a positive integer");
    if (this.platform === "linux") {
      try {
        return parseLinuxProcessStart(
          await this.readText(`/proc/${pid}/stat`),
          pid,
        );
      } catch (error) {
        if (error instanceof BootIdentityError) throw error;
        throw new BootIdentityError(`Linux process ${pid} is unavailable`);
      }
    }
    if (this.platform === "win32") {
      const script = [
        `$value = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
        "if ($null -eq $value) { exit 3 }",
        "$value.ToUniversalTime().ToString('O', [Globalization.CultureInfo]::InvariantCulture)",
      ].join("; ");
      try {
        return `win32:${canonicalWindowsCimTimestamp(await this.powershell(script))}`;
      } catch (error) {
        if (error instanceof BootIdentityError) throw error;
        throw new BootIdentityError(
          `Windows process ${pid} creation identity is unavailable`,
        );
      }
    }
    throw new BootIdentityError(
      `Process creation identity is unsupported on ${this.platform}`,
    );
  }

  async isProcessAlive(
    pid: number,
    processCreatedAt: string,
  ): Promise<boolean> {
    let actual: string;
    try {
      actual = await this.processCreatedAt(pid);
    } catch (error) {
      if (error instanceof BootIdentityError) return false;
      throw error;
    }
    if (actual !== processCreatedAt) return false;
    try {
      this.kill(pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EPERM"
      )
        return true;
      return false;
    }
  }

  async listeningPid(port: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new BootIdentityError("Service port is invalid");
    if (this.platform === "win32") {
      const script = [
        `$connection = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
        "if ($null -eq $connection) { exit 3 }",
        "$connection.OwningProcess",
      ].join("; ");
      try {
        const stdout = nonEmpty(await this.powershell(script), "Port owner");
        const pid = Number(stdout);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    }
    const portHex = port.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set<string>();
    for (const filename of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let contents = "";
      try {
        contents = await this.readText(filename);
      } catch {
        continue;
      }
      for (const line of contents.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (
          fields.length < 10 ||
          fields[3] !== "0A" ||
          !fields[1].endsWith(`:${portHex}`) ||
          !/^\d+$/.test(fields[9]) ||
          fields[9] === "0"
        )
          continue;
        inodes.add(fields[9]);
      }
    }
    if (!inodes.size) return undefined;
    const pids = (await this.readDirectory("/proc"))
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .sort((left, right) => left - right);
    for (const pid of pids) {
      let descriptors: string[] = [];
      try {
        descriptors = await this.readDirectory(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const descriptor of descriptors) {
        try {
          const link = await this.readLink(`/proc/${pid}/fd/${descriptor}`);
          for (const inode of inodes) {
            if (link === `socket:[${inode}]`) return pid;
          }
        } catch {
          // A process may exit or its descriptor table may be inaccessible.
        }
      }
    }
    return undefined;
  }
}
