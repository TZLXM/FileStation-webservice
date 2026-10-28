import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {AttemptJournal, UpdateCapabilityAuthority, encodeInheritedCapability} from '@filestation/updater';
import {InheritedTrustedStartupAccess} from '../maintenance/inherited-startup-access';
import {bootstrap} from '../main';
import {startValidationApplication,startGatedApplication} from '../maintenance/server-startup';

jest.mock('../maintenance/server-startup',()=>({startValidationApplication:jest.fn(),startGatedApplication:jest.fn()}));
let mockExecutable: string;
jest.mock('fs/promises',()=>({...jest.requireActual('fs/promises'),realpath:async (p:string)=>p.endsWith('main.ts') ? mockExecutable : jest.requireActual('fs/promises').realpath(p)}));

describe('actual authorized bootstrap disk preflight before module startup',()=>{
  let root:string; let environment:NodeJS.ProcessEnv; let argv:string[];
  beforeEach(async()=>{
    environment={...process.env}; argv=process.argv;
    root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'filestation-authorized-preflight-')));
    const release=path.join(root,'releases','v0.2.5');
    mockExecutable=path.join(release,'apps/server/dist/main.js');
    await fs.mkdir(path.dirname(mockExecutable),{recursive:true}); await fs.writeFile(mockExecutable,'fixture');
    await fs.symlink(release,path.join(root,'current'),process.platform==='win32'?'junction':'dir');
    for(const name of ['database','storage','temp']) await fs.mkdir(path.join(root,name));
    await fs.writeFile(path.join(root,'.env'),'');
    await fs.writeFile(path.join(root,'managed-install.json'),JSON.stringify({schemaVersion:1,installId:'fixture',installRoot:root,currentPath:path.join(root,'current'),environmentPath:path.join(root,'.env'),paths:{database:path.join(root,'database','source.db'),storage:path.join(root,'storage'),temp:path.join(root,'temp')},bootstrapBackupId:'bootstrap-fixture',bootstrapFingerprint:'b'.repeat(64),createdAt:new Date().toISOString(),productionEnvironment:{nodeEnv:'production',required:['NODE_ENV','JWT_SECRET'],source:'service'}}));
    process.env.FILESTATION_INSTALL_ROOT=root; process.env.NODE_ENV='production'; process.env.JWT_SECRET='synthetic-fixture-only';
    for(const key of ['FILESTATION_DB_PATH','FILESTATION_STORAGE_PATH','FILESTATION_TEMP_PATH']) delete process.env[key];
    jest.spyOn(process,'cwd').mockReturnValue(root);
    (startValidationApplication as jest.Mock).mockRejectedValue(new Error('startup-import-boundary'));
    (startGatedApplication as jest.Mock).mockRejectedValue(new Error('startup-import-boundary'));
  });
  afterEach(async()=>{process.env=environment;process.argv=argv;jest.restoreAllMocks();jest.clearAllMocks();await fs.rm(root,{recursive:true,force:true});});

  async function run(mode:'validate'|'gated') {
    const journal=await AttemptJournal.open(root);
    await journal.beginAttempt({attemptId:'attempt-preflight',fence:2,currentVersion:'0.2.0',targetVersion:'0.2.5',backupId:'backup-preflight',phase:mode==='validate'?'CURRENT_SWITCHED':'MIGRATED_VERIFIED',owner:{bootIdentity:'fixture',pid:1234,processCreatedAt:'fixture-created',heartbeatAt:new Date().toISOString()}});
    async function* inherited(){yield encodeInheritedCapability(new UpdateCapabilityAuthority());}
    const access=await InheritedTrustedStartupAccess.fromInherited(inherited());
    process.argv=['node',mockExecutable,`--startup-mode=${mode}`,'--attempt-id=attempt-preflight','--fence=2',`--install-root=${root}`,'--backup-id=backup-preflight','--target-version=0.2.5'];
    return bootstrap(access);
  }

  it.each(['validate','gated'] as const)('%s accepts unchanged canonical paths with verified inherited authority',async mode=>{
    await expect(run(mode)).rejects.toThrow('startup-import-boundary');
    expect(mode==='validate'?startValidationApplication:startGatedApplication).toHaveBeenCalledTimes(1);
  });
  it.each((['validate','gated'] as const).flatMap(mode=>(['database','storage','temp'] as const).map(kind=>({mode,kind}))))('$mode rejects retargeted $kind ancestor before startup/import/writes',async ({mode,kind})=>{
    const target=path.join(root,'retargeted');await fs.mkdir(target);
    await fs.rm(path.join(root,kind),{recursive:true});
    await fs.symlink(target,path.join(root,kind),process.platform==='win32'?'junction':'dir');
    await expect(run(mode)).rejects.toThrow(/canonical target drift/i);
    expect(startValidationApplication).not.toHaveBeenCalled();expect(startGatedApplication).not.toHaveBeenCalled();
    expect(await fs.readdir(target)).toEqual([]);
  });
  it.each(['validate','gated'] as const)('%s refuses missing service production environment before import',async mode=>{
    delete process.env.JWT_SECRET;
    await expect(run(mode)).rejects.toThrow(/service environment/i);
    expect(startValidationApplication).not.toHaveBeenCalled();expect(startGatedApplication).not.toHaveBeenCalled();
  });
});
