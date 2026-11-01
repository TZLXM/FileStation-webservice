import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AttemptJournal } from '../state/attempt-journal';

const issued = new WeakSet<OperatorRecoveryAuthority>();
const issuer = Symbol('verified operator boundary');
const exec = promisify(execFile);

/** Local administrator command authority. This is never a remote flag or a
 * substitute for the inherited handoff secret. The OS protected installation
 * boundary must authorize the caller before an object can be issued. */
export class OperatorRecoveryAuthority {
  private constructor(readonly root: string, readonly attemptId: string, readonly fence: number, token: symbol) {
    if(token!==issuer) throw new Error('operator authority must verify the protected OS boundary');
    issued.add(this);
  }

  static async authorize(root: string, attemptId: string, fence: number): Promise<OperatorRecoveryAuthority> {
    root = path.resolve(root);
    if (await realpath(root) !== root) throw new Error('operator recovery root must be canonical');
    const targets = [root, path.join(root, 'managed-install.json'), path.join(root, 'update-attempt.journal')];
    for (const target of targets) {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('operator authority cannot follow links');
      if (process.platform === 'win32') {
        // Encode as data, never interpolate a path as PowerShell source.
        const encoded = Buffer.from(target, 'utf16le').toString('base64');
        const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $a=[IO.${info.isDirectory() ? 'Directory' : 'File'}]::GetAccessControl($p); $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($me,'S-1-5-18','S-1-5-32-544'); if (-not $a.AreAccessRulesProtected) {throw 'operator boundary inherits permissions'}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value){throw 'operator boundary has foreign access'}}; if($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'operator boundary has foreign owner'}; 'authorized'`;
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide:true});
        if (stdout.trim() !== 'authorized') throw new Error('operator authority ACL verification failed');
      } else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
        throw new Error('operator boundary must be private and owned by this account');
      }
    }
    const snapshot = await AttemptJournal.inspectRecoverable(root);
    if (snapshot.attemptId !== attemptId || snapshot.fence !== fence) throw new Error('operator authority attempt/fence changed');
    return new OperatorRecoveryAuthority(root, attemptId, fence, issuer);
  }

  assert(root: string, attemptId: string, fence: number): void {
    if (!issued.has(this) || path.resolve(root) !== this.root || attemptId !== this.attemptId || fence !== this.fence)
      throw new Error('operator recovery authority is mismatched');
  }
}
