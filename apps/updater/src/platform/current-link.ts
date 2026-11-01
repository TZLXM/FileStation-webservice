import { createHash } from "node:crypto";
import path from "node:path";
import {
  AttemptJournal,
  AttemptJournalSnapshot,
  JsonValue,
} from "../state/attempt-journal";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "./durable-fs";

export interface SwitchAttempt {
  attemptId: string;
  fence: number;
}

export interface CurrentLinkCrashPoint {
  action:
    | "stage-current-link"
    | "detach-current"
    | "attach-current"
    | "replace-current";
  when: "after-intent" | "after-action" | "after-completion";
}

export interface CurrentLinkSwitchOptions {
  crashAt?: CurrentLinkCrashPoint;
}

export interface CurrentLinkResult {
  state: "completed" | "restored";
  target: string;
  failClosed: false;
}

export interface CurrentLinkSwitcherOptions {
  fs?: DurableFileSystem;
  platform?: NodeJS.Platform;
}

interface LinkPayload {
  platform: "posix" | "win32";
  target: string;
  originalTarget: string;
  stage: string;
  current: string;
  previous?: string;
}

export class CurrentLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrentLinkError";
  }
}

export class CurrentLinkAmbiguousError extends CurrentLinkError {
  constructor(message: string) {
    super(message);
    this.name = "CurrentLinkAmbiguousError";
  }
}

function tokenFor(attempt: SwitchAttempt): string {
  if (
    !attempt ||
    typeof attempt.attemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.fence) ||
    attempt.fence < 1
  )
    throw new CurrentLinkError("switch attempt identity is invalid");
  return createHash("sha256")
    .update(`${attempt.attemptId}:${attempt.fence}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string) =>
    {
      const normalized = path
        .resolve(value.replace(/^\\\\\?\\/, ""))
        .replace(/[\\/]+$/, "");
      return platform === "win32" ? normalized.toLowerCase() : normalized;
    };
  return normalize(left) === normalize(right);
}

function payloadFrom(value: JsonValue | undefined): LinkPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CurrentLinkAmbiguousError("link intent payload is malformed");
  const raw = value as Record<string, JsonValue>;
  if (
    (raw.platform !== "win32" && raw.platform !== "posix") ||
    typeof raw.target !== "string" ||
    typeof raw.originalTarget !== "string" ||
    typeof raw.stage !== "string" ||
    typeof raw.current !== "string" ||
    (raw.previous !== undefined && typeof raw.previous !== "string")
  )
    throw new CurrentLinkAmbiguousError("link intent payload is malformed");
  return raw as unknown as LinkPayload;
}

export class CurrentLinkSwitcher {
  private readonly fs: DurableFileSystem;
  private readonly platform: NodeJS.Platform;
  private readonly current: string;

  constructor(
    private readonly root: string,
    private readonly journal: AttemptJournal,
    options: CurrentLinkSwitcherOptions = {},
  ) {
    this.fs = options.fs ?? new NodeDurableFileSystem();
    this.platform = options.platform ?? process.platform;
    this.current = path.join(root, "current");
  }

  private async exists(filename: string): Promise<boolean> {
    return this.fs.exists(filename);
  }

  private async isLink(filename: string): Promise<boolean> {
    try {
      return (await this.fs.lstat(filename)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  private async linkTarget(filename: string): Promise<string | undefined> {
    if (!(await this.exists(filename))) return undefined;
    if (!(await this.isLink(filename)))
      throw new CurrentLinkAmbiguousError(
        `${filename} exists but is not a symlink/junction`,
      );
    const target = await this.fs.readlink(filename);
    return path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(filename), target);
  }

  private async validateTarget(target: string): Promise<string> {
    const absolute = path.resolve(target);
    const stat = await this.fs.stat(absolute);
    if (!stat.isDirectory())
      throw new CurrentLinkError("release target is not a directory");
    return absolute;
  }

  private crash(
    option: CurrentLinkSwitchOptions | undefined,
    action: CurrentLinkCrashPoint["action"],
    when: CurrentLinkCrashPoint["when"],
  ): void {
    if (
      option?.crashAt?.action === action &&
      option.crashAt.when === when
    )
      throw new Error(`injected crash: ${action} ${when}`);
  }

  private async appendIntent(
    attempt: SwitchAttempt,
    action: string,
    payload: LinkPayload,
  ) {
    return this.journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      action,
      phase: "SWITCH_INTENT",
      payload: payload as unknown as JsonValue,
    });
  }

  private async complete(
    attempt: SwitchAttempt,
    intentId: string,
    phase: "SWITCH_INTENT" | "CURRENT_SWITCHED",
    result: JsonValue,
  ): Promise<void> {
    await this.journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      intentId,
      phase,
      result,
    });
  }

  async switchTo(
    target: string,
    attempt: SwitchAttempt,
    options: CurrentLinkSwitchOptions = {},
  ): Promise<CurrentLinkResult> {
    const absoluteTarget = await this.validateTarget(target);
    const token = tokenFor(attempt);
    if (!(await this.exists(this.current)))
      throw new CurrentLinkError("current link is missing");
    if (!(await this.isLink(this.current)))
      throw new CurrentLinkError("current is not a symlink/junction");
    const releases = path.join(this.root, "releases");
    await this.fs.ensurePrivateDirectory(releases);

    if (this.platform === "win32") {
      const stage = path.join(releases, `.stage-attempt-${token}`);
      const previous = path.join(releases, `previous-attempt-${token}`);
      const payload: LinkPayload = {
        platform: "win32",
        target: absoluteTarget,
        originalTarget: (await this.linkTarget(this.current))!,
        stage,
        current: this.current,
        previous,
      };
      for (const existing of [stage, previous]) {
        if (await this.exists(existing))
          throw new CurrentLinkAmbiguousError(
            `attempt-specific link path already exists: ${existing}`,
          );
      }

      let intent = await this.appendIntent(
        attempt,
        "stage-current-link",
        payload,
      );
      this.crash(options, "stage-current-link", "after-intent");
      await this.fs.createJunction(absoluteTarget, stage);
      this.crash(options, "stage-current-link", "after-action");
      await this.complete(attempt, intent.id, "SWITCH_INTENT", {
        stage,
      });

      this.crash(options, "stage-current-link", "after-completion");
      intent = await this.appendIntent(attempt, "detach-current", payload);
      this.crash(options, "detach-current", "after-intent");
      await this.fs.rename(this.current, previous, { replace: false });
      this.crash(options, "detach-current", "after-action");
      await this.complete(attempt, intent.id, "SWITCH_INTENT", {
        previous,
      });

      this.crash(options, "detach-current", "after-completion");
      intent = await this.appendIntent(attempt, "attach-current", payload);
      this.crash(options, "attach-current", "after-intent");
      await this.fs.rename(stage, this.current, { replace: false });
      this.crash(options, "attach-current", "after-action");
      await this.complete(attempt, intent.id, "CURRENT_SWITCHED", {
        target: absoluteTarget,
        previous,
      });
      this.crash(options, "attach-current", "after-completion");
      return { state: "completed", target: absoluteTarget, failClosed: false };
    }

    const stage = path.join(
      this.root,
      `.current.tmp-${token}`,
    );
    if (await this.exists(stage))
      throw new CurrentLinkAmbiguousError(
        `attempt-specific temporary symlink already exists: ${stage}`,
      );
    const payload: LinkPayload = {
      platform: "posix",
      target: absoluteTarget,
      originalTarget: (await this.linkTarget(this.current))!,
      stage,
      current: this.current,
    };
    let intent = await this.appendIntent(
      attempt,
      "stage-current-link",
      payload,
    );
    this.crash(options, "stage-current-link", "after-intent");
    await this.fs.symlink(absoluteTarget, stage);
    this.crash(options, "stage-current-link", "after-action");
    await this.complete(attempt, intent.id, "SWITCH_INTENT", { stage });

    this.crash(options, "stage-current-link", "after-completion");
    intent = await this.appendIntent(attempt, "replace-current", payload);
    this.crash(options, "replace-current", "after-intent");
    await this.fs.rename(stage, this.current, { replace: true });
    this.crash(options, "replace-current", "after-action");
    await this.complete(attempt, intent.id, "CURRENT_SWITCHED", {
      target: absoluteTarget,
    });
    this.crash(options, "replace-current", "after-completion");
    return { state: "completed", target: absoluteTarget, failClosed: false };
  }

  async recover(
    snapshot: AttemptJournalSnapshot,
  ): Promise<CurrentLinkResult> {
    if (!snapshot.initialized || !snapshot.attemptId || !snapshot.phase)
      throw new CurrentLinkAmbiguousError("journal attempt is not initialized");
    const actions = new Set(["stage-current-link", "detach-current", "attach-current", "replace-current", "cleanup-staged-link", "restore-previous"]);
    const source = snapshot.pending ?? [...snapshot.records].reverse().find(record => record.kind === "intent" && actions.has(record.action!));
    if (!source || !actions.has(source.action!)) throw new CurrentLinkAmbiguousError("no recoverable link history");
    const payload = payloadFrom(source.payload);
    const current = await this.linkTarget(payload.current);
    const stage = await this.linkTarget(payload.stage);
    const previous = payload.previous ? await this.linkTarget(payload.previous) : undefined;
    const matches = (value: string | undefined, target: string) => !!value && samePath(value, target, this.platform);
    if (stage && !matches(stage, payload.target)) throw new CurrentLinkAmbiguousError("unexpected staged target");
    if (previous && !matches(previous, payload.originalTarget)) throw new CurrentLinkAmbiguousError("unexpected previous target");
    if (current && !matches(current, payload.target) && !matches(current, payload.originalTarget)) throw new CurrentLinkAmbiguousError("unexpected current target");
    const complete = async (phase: "SWITCH_INTENT" | "CURRENT_SWITCHED" | "ROLLED_BACK") => {
      if (snapshot.pending) await this.journal.appendCompletion({ attemptId: snapshot.attemptId!, fence: snapshot.fence, intentId: snapshot.pending.intentId, phase, result: { target: current ?? payload.originalTarget } });
    };
    if (matches(current, payload.target) && !stage && (payload.platform === "posix" || !!previous)) {
      if (!["attach-current", "replace-current"].includes(source.action!)) throw new CurrentLinkAmbiguousError("new current without an attach operation");
      await complete("CURRENT_SWITCHED");
      return { state: "completed", target: payload.target, failClosed: false };
    }
    if (snapshot.phase === "CURRENT_SWITCHED" || snapshot.phase === "COMMITTED") throw new CurrentLinkAmbiguousError("completed switch filesystem differs");
    if (matches(current, payload.originalTarget) && !previous) {
      if (["detach-current", "replace-current", "restore-previous"].includes(source.action!) && !stage)
        throw new CurrentLinkAmbiguousError("required staged link is missing");
      if (source.action === "attach-current")
        throw new CurrentLinkAmbiguousError("attach recovery lost the previous link");
      await complete(source.action === "cleanup-staged-link" && !stage ? "ROLLED_BACK" : "SWITCH_INTENT");
    } else if (!current && previous && stage && payload.previous && payload.platform === "win32") {
      await complete("SWITCH_INTENT");
      await this.recoveryAction("restore-previous", payload, snapshot, async () => {
        await this.fs.rename(payload.previous!, payload.current, { replace: false });
      }, "SWITCH_INTENT");
    } else {
      throw new CurrentLinkAmbiguousError("link recovery filesystem matrix is ambiguous");
    }
    // Cleanup is itself journaled even when staging never ran. Repeated recovery
    // can therefore finish either side of its action/completion boundary.
    const latest = await this.journal.readSnapshot();
    if (latest.phase !== "ROLLED_BACK") await this.recoveryAction("cleanup-staged-link", payload, latest, async () => {
      if (await this.fs.exists(payload.stage)) await this.fs.unlink(payload.stage);
    }, "ROLLED_BACK");
    return { state: "restored", target: payload.originalTarget, failClosed: false };
  }

  private async recoveryAction(action: string, payload: LinkPayload, snapshot: AttemptJournalSnapshot, operation: () => Promise<void>, phase: "SWITCH_INTENT" | "ROLLED_BACK"): Promise<void> {
    const intent = await this.journal.appendIntent({ attemptId: snapshot.attemptId!, fence: snapshot.fence, action, phase: "ROLLBACK_INTENT", payload: payload as unknown as JsonValue });
    await operation();
    await this.journal.appendCompletion({ attemptId: snapshot.attemptId!, fence: snapshot.fence, intentId: intent.id, phase, result: { recovered: true } });
  }
}
