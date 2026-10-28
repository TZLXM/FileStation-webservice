import {spawn, ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {AttemptJournal, AttemptPhase} from '../state/attempt-journal';
import {UpdateLock} from '../state/update-lock';
import {PlatformBootIdentityProvider} from '../state/boot-identity';
import {NodeDurableFileSystem} from '../platform/durable-fs';
import {CurrentLinkSwitcher} from '../platform/current-link';

jest.setTimeout(120_000);
const compiled=path.resolve(__dirname,'../../dist');
const durable=new NodeDurableFileSystem();
const identity=new PlatformBootIdentityProvider();

async function port() {
  const listener=net.createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
  const result=(listener.address() as net.AddressInfo).port;
  await new Promise<void>(r=>listener.close(()=>r())); return result;
}
async function exited(child:ChildProcess) {if(child.exitCode===null && child.signalCode===null) await once(child,'exit');}

async function fixture(phase:AttemptPhase,pending?:string, reboot=false) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'fs-production-recovery-')));
  const servicePort=await port();
  const paths={database:path.join(root,'runtime/db.sqlite'),storage:path.join(root,'runtime/storage'),temp:path.join(root,'runtime/temp')};
  for(const directory of [path.dirname(paths.database),paths.storage,paths.temp,path.join(root,'updater/dist'),path.join(root,'backups/backup')]) await mkdir(directory,{recursive:true});
  await writeFile(paths.database,'changed-db'); await writeFile(paths.database+'-wal','failed-wal');
  const backup=path.join(root,'backups/backup/update-snapshot.sqlite');await writeFile(backup,'verified-db');
  const previous=path.join(root,'releases/v0.2.0-old'),next=path.join(root,'releases/v0.2.5-'+ 'b'.repeat(12));
  for(const [release,version] of [[previous,'0.2.0'],[next,'0.2.5']]) {
    await mkdir(path.join(release,'apps/server/dist'),{recursive:true});
    await writeFile(path.join(release,'package.json'),JSON.stringify({version}));
    // Only the business listener is synthetic. Journal, locks, CLI, launch
    // preflight, child identity, IPC proof, link and DB restore are production.
    await writeFile(path.join(release,'apps/server/dist/main.js'),`
      exports.bootstrap=async()=>{
        while(require('fs').existsSync(${JSON.stringify(path.join(root,'fixture-startup-pause'))}))await new Promise(r=>setTimeout(r,20));
        if(process.env.NODE_ENV!=='production'||process.env.JWT_SECRET!=='synthetic-service-secret'||process.env.FILESTATION_PORT!=='${servicePort}')throw Error('service config lost');
        const http=require('http');const app=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({version:'${version}'}));});
        await new Promise((r,j)=>{app.once('error',j);app.listen(Number(process.env.FILESTATION_PORT),'127.0.0.1',r)});
        return {app:{getHttpServer:()=>app},restartHealth:{health:'ok',version:'${version}',release:${JSON.stringify(release)}}};
      };
      if(require.main===module){
        const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{
          const gatedFailure=require('fs').existsSync(${JSON.stringify(path.join(root,'fixture-gated-failure'))});
          if(!gatedFailure && !require('fs').existsSync(${JSON.stringify(path.join(root,'fixture-health-failure'))}))process.exit(14);
          const envelope=JSON.parse(Buffer.concat(chunks).toString());
          const validating=process.argv.includes('--startup-mode=validate');
          const server=require('http').createServer((q,s)=>{s.statusCode=gatedFailure && validating?200:503;s.end(JSON.stringify({status:validating?'validating':'gated'}));});
          server.listen(Number(envelope.runtime.FILESTATION_PORT),'127.0.0.1');
        });
      }
    `);
  }
  await durable.createJunction(previous,path.join(root,'current')).catch(()=>durable.symlink(previous,path.join(root,'current')));
  await durable.writeAtomic(path.join(root,'managed-install.json'),Buffer.from(JSON.stringify({schemaVersion:1,installId:'fixture',installRoot:root,currentPath:path.join(root,'current'),environmentPath:path.join(root,'.env'),paths,bootstrapBackupId:'bootstrap',bootstrapFingerprint:'a'.repeat(64),createdAt:new Date().toISOString(),productionEnvironment:{nodeEnv:'production',required:['NODE_ENV','JWT_SECRET'],source:'service'}})),{mode:0o600});
  await writeFile(path.join(root,'updater/dist/cli.js'),`process.on('exit',code=>require('fs').writeFileSync(${JSON.stringify(path.join(root,'fixture-launch-exit.txt'))},String(code)));process.on('uncaughtException',e=>{require('fs').writeFileSync(${JSON.stringify(path.join(root,'fixture-launch-error.txt'))},e.stack);process.exit(1);});require(${JSON.stringify(path.join(compiled,'cli.js'))}).main().catch(e=>{require('fs').writeFileSync(${JSON.stringify(path.join(root,'fixture-launch-error.txt'))},e.stack);process.exit(1);});`);
  const old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await once(old,'spawn');
  const createdAt=await identity.processCreatedAt(old.pid!);const boot=(await identity.current()).value;
  const journal=await AttemptJournal.open(root);
  const provider=reboot?{current:async()=>({provider:'linux-proc' as const,value:'fixture-previous-boot'}),processCreatedAt:(pid:number)=>identity.processCreatedAt(pid),isProcessAlive:(pid:number,created:string)=>identity.isProcessAlive(pid,created)}:identity;
  const owner=await UpdateLock.acquire(root,{attemptId:'attempt-real',bootIdentity:reboot?'fixture-previous-boot':boot,pid:old.pid!,processCreatedAt:createdAt,heartbeatAt:new Date().toISOString(),handoffIdentityHash:createHash('sha256').update('fixture-handoff').digest('hex'),currentVersion:'0.2.0',targetVersion:'0.2.5',previousVersion:'0.2.0',backupId:'backup'},{journal,identityProvider:provider});
  const action=async(action:string,p:AttemptPhase,payload:object={})=>{
    const i=await journal.appendIntent({attemptId:'attempt-real',fence:owner.fence,action,phase:p,payload:payload as never});
    await journal.appendCompletion({attemptId:'attempt-real',fence:owner.fence,intentId:i.id,phase:p});
  };
  await action('prepare-update','PREPARED',{stagingPath:path.join(root,'releases/staging'),targetVersion:'0.2.5',artifactSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),databasePath:paths.database});
  if(!['PREPARED','MAINTENANCE'].includes(phase)) await action('snapshot-database','SNAPSHOT_READY',{path:backup,sha256:createHash('sha256').update('verified-db').digest('hex')});
  if(['SWITCH_INTENT','CURRENT_SWITCHED','MIGRATING','MIGRATED_VERIFIED','READY_TO_COMMIT','COMMITTED','ROLLBACK_INTENT'].includes(phase)) {
    try {await new CurrentLinkSwitcher(root,journal).switchTo(next,{attemptId:'attempt-real',fence:owner.fence},pending==='interrupted-switch'?{crashAt:{action:process.platform==='win32'?'attach-current':'replace-current',when:'after-action'}}:{});}catch(error){if(pending!=='interrupted-switch')throw error;}
  }
  if(!(await journal.readSnapshot()).pending) await action('fixture-stage',phase);
  if(pending && pending!=='interrupted-switch') await journal.appendIntent({attemptId:'attempt-real',fence:owner.fence,action:pending,phase,payload:{version:'0.2.5',release:next}});
  old.kill('SIGKILL');await exited(old);
  const worker=path.join(root,'worker.js');
  await writeFile(worker,`
    (async()=>{
      const {OperatorRecoveryAuthority}=require(${JSON.stringify(path.join(compiled,'update/operator-authority.js'))});
      const {createManagedUpdateOrchestrator}=require(${JSON.stringify(path.join(compiled,'update/orchestrator.js'))});
      const {AttemptJournal}=require(${JSON.stringify(path.join(compiled,'state/attempt-journal.js'))});
      const {NodeDurableFileSystem}=require(${JSON.stringify(path.join(compiled,'platform/durable-fs.js'))});
      class CrashFS extends NodeDurableFileSystem {
        async append(file,bytes,options){
          await super.append(file,bytes,options);
          const record=JSON.parse(bytes.toString());
          if(process.env.FIXTURE_CRASH===record.action+':intent' && record.kind==='intent')process.exit(73);
          if(process.env.FIXTURE_CRASH==='terminal:completion' && record.kind==='completion' && record.result && record.result.nonce)process.exit(73);
        }
        async rename(source,target,options){
          await super.rename(source,target,options);
          if(process.env.FIXTURE_CRASH==='restore:publication' && target===${JSON.stringify(paths.database)})process.exit(73);
          if(process.env.FIXTURE_CRASH==='previous:detach' && require('path').basename(target).startsWith('.rollback-new-'))process.exit(73);
          if(process.env.FIXTURE_CRASH==='previous:attach' && require('path').basename(source).startsWith('.rollback-current-'))process.exit(73);
        }
      }
      const root=${JSON.stringify(root)};
      const snapshot=await AttemptJournal.inspect(root);
      const operatorAuthority=await OperatorRecoveryAuthority.authorize(root,'attempt-real',snapshot.fence);
      const orchestrator=createManagedUpdateOrchestrator({handoffIdentity:process.env.FIXTURE_FORWARD?'fixture-handoff':'',operatorAuthority,fs:new CrashFS(),runtime:{NODE_ENV:'production',JWT_SECRET:'synthetic-service-secret',FILESTATION_PORT:'${servicePort}'}});
      const result=await orchestrator.run({attemptId:'attempt-real',installRoot:root,handoffIdentity:'',servicePort:${servicePort},timeoutMs:15000,recovery:!process.env.FIXTURE_FORWARD});
      console.log(JSON.stringify(result));
    })().catch(e=>{console.error(e.message);process.exitCode=1;});
  `);
  const run=async(crash?:string,forward=false)=>{
    const child=spawn(process.execPath,[worker],{cwd:root,windowsHide:true,env:{...process.env,FIXTURE_CRASH:crash,FIXTURE_FORWARD:forward?'1':undefined},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout!.on('data',x=>output+=x);child.stderr!.on('data',x=>output+=x);
    let timer:ReturnType<typeof setTimeout>;
    let timedOut=false;
    const completion=exited(child);
    const timeout=new Promise<void>(resolve=>{timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');resolve();},60000);});
    await Promise.race([completion,timeout]);clearTimeout(timer!);
    if(timedOut) {
      let forcedTimer:ReturnType<typeof setTimeout>;
      try {await Promise.race([completion,new Promise<never>((_r,reject)=>{forcedTimer=setTimeout(()=>reject(new Error('fixture worker exit not proven after timeout SIGKILL')),10000);})]);}
      finally {clearTimeout(forcedTimer!);}
      const state=await AttemptJournal.inspect(root);
      throw new Error(`fixture worker exceeded 60s at ${state.phase}/${state.pending?.action ?? 'no-pending'}; exit=${child.exitCode}/${child.signalCode}; ${output}`);
    }
    try{output+=await readFile(path.join(root,'fixture-launch-error.txt'),'utf8');}catch{}
    return {code:child.exitCode,output};
  };
  const cleanup=async()=>{
    const s=await AttemptJournal.inspect(root);
    const pids=new Set<number>();
    for(const r of s.records) if(r.kind==='completion' && r.result && typeof r.result==='object' && !Array.isArray(r.result) && typeof r.result.pid==='number') pids.add(r.result.pid);
    try {const ledger=JSON.parse(await readFile(path.join(root,'update.processes.json'),'utf8'));ledger.children.forEach((c:{pid:number})=>pids.add(c.pid));}catch{}
    for(const pid of pids) {try {process.kill(pid,'SIGKILL');}catch{}}
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  };
  return {root,servicePort,paths,previous,next,journal,run,cleanup};
}

describe('production recovery entry and stable launcher',()=>{
  it.each(['startup','health','gated-health'])('rolls back an actual failing validation %s with its forward intent pending',async failure=>{
    const v=await fixture('HANDOFF_READY');
    try {if(failure==='health')await writeFile(path.join(v.root,'fixture-health-failure'),'fail');if(failure==='gated-health')await writeFile(path.join(v.root,'fixture-gated-failure'),'fail');const result=await v.run(undefined,true);if(result.code!==0)throw new Error(result.output);expect(await realpath(path.join(v.root,'current'))).toBe(v.previous);expect(await readFile(v.paths.database,'utf8')).toBe('verified-db');const state=await AttemptJournal.inspect(v.root);expect(state.records.some(r=>r.kind==='intent' && r.action==='validate-release')).toBe(true);expect(state.pending).toBeNull();}
    finally{await v.cleanup();}
  });
  it.each(['verify-committed-restart:intent','terminal:completion'])('recovers an actual committed verification exit at %s with a fresh new-only launcher',async point=>{
    const v=await fixture('COMMITTED');
    try {expect(await v.run(point)).toMatchObject({code:73});const before=await AttemptJournal.inspect(v.root);const result=await v.run();if(result.code!==0)throw new Error(result.output);const after=await AttemptJournal.inspect(v.root);expect(after.phase).toBe('COMMITTED');expect(after.pending).toBeNull();expect(await realpath(path.join(v.root,'current'))).toBe(v.next);expect(await readFile(v.paths.database,'utf8')).toBe('changed-db');if(point==='terminal:completion')expect((after.records.at(-1)?.result as any).pid).not.toBe((before.records.at(-1)?.result as any).pid);}
    finally{await v.cleanup();}
  });
  it('recovers an interrupted switch and the previous boot with protected operator authority',async()=>{
    const v=await fixture('CURRENT_SWITCHED','interrupted-switch',true);
    try {const result=await v.run();if(result.code!==0)throw new Error(result.output);expect(await realpath(path.join(v.root,'current'))).toBe(v.previous);expect(await readFile(v.paths.database,'utf8')).toBe('verified-db');}
    finally{await v.cleanup();}
  });
  it('holds the OS exclusion through committed startup verification',async()=>{
    const v=await fixture('COMMITTED');const pause=path.join(v.root,'fixture-startup-pause');
    await writeFile(pause,'pause');
    const running=v.run();
    try {
      const deadline=Date.now()+30000;
      while((await AttemptJournal.inspect(v.root)).pending?.action!=='verify-committed-restart') {if(Date.now()>deadline)throw new Error('verification intent absent');await new Promise(r=>setTimeout(r,50));}
      const {acquireRecoveryGuard}=await import('../platform/recovery-guard');
      await expect(acquireRecoveryGuard(path.join(v.root,'update.recovery.guard'))).rejects.toThrow();
      await rm(pause);const result=await running;if(result.code!==0)throw new Error(result.output);
    }finally{await rm(pause,{force:true});await running;await v.cleanup();}
  });
  it.each(['rollback-plan:intent','rollback-database:intent','restore:publication','select-previous:intent',...(process.platform==='win32'?['previous:detach']:[]),'previous:attach','complete-rollback:intent','launch-terminal:intent'])('recovers an actual updater exit at %s',async point=>{
    const v=await fixture('MIGRATING','validate-release');
    try {
      expect(await v.run(point)).toMatchObject({code:73});
      const result=await v.run();if(result.code!==0)throw new Error(result.output);
      expect(await realpath(path.join(v.root,'current'))).toBe(v.previous);
      expect(await readFile(v.paths.database,'utf8')).toBe('verified-db');
      expect((await AttemptJournal.inspect(v.root)).pending).toBeNull();
    }finally{await v.cleanup();}
  });
  it.each(['PREPARED','MAINTENANCE','SNAPSHOT_READY','OLD_STOPPED','CURRENT_SWITCHED','MIGRATING','MIGRATED_VERIFIED','READY_TO_COMMIT','ROLLBACK_INTENT'] as const)('recovers initial %s with real links, journal and child launch',async phase=>{
    const v=await fixture(phase,phase==='MIGRATING'?'validate-release':undefined);
    try {
      const result=await v.run();if(result.code!==0)throw new Error(result.output);
      expect(result.output).toContain('rolled_back');
      expect(await realpath(path.join(v.root,'current'))).toBe(v.previous);
      expect(await readFile(v.paths.database,'utf8')).toBe(['PREPARED','MAINTENANCE','SNAPSHOT_READY'].includes(phase)?'changed-db':'verified-db');
      expect((await AttemptJournal.inspect(v.root)).pending).toBeNull();
      try {const response=await fetch(`http://127.0.0.1:${v.servicePort}`);expect(await response.json()).toEqual({version:'0.2.0'});}
      catch(error){let detail='';for(const file of ['fixture-launch-error.txt','fixture-launch-exit.txt'])try{detail+=file+':'+await readFile(path.join(v.root,file),'utf8');}catch{}const last=(await AttemptJournal.inspect(v.root)).records.at(-1)?.result as any;detail+=' processAlive='+await identity.isProcessAlive(last.pid,last.createdAt);detail+=' portOwner='+await identity.listeningPid!(v.servicePort);throw new Error(String(error)+' cause='+String((error as any).cause)+' '+detail);}
    } finally {await v.cleanup();}
  });
  it.each(['verify-committed-restart','commit-update'])('resumes pending COMMITTED %s through a fresh stable launcher, preserving new DB',async action=>{
    const v=await fixture('COMMITTED',action);
    try {
      const result=await v.run();if(result.code!==0)throw new Error(result.output);
      expect(await realpath(path.join(v.root,'current'))).toBe(v.next);
      expect(await readFile(v.paths.database,'utf8')).toBe('changed-db');
      const state=await AttemptJournal.inspect(v.root);
      expect(state.phase).toBe('COMMITTED');expect(state.pending).toBeNull();
      expect(state.records.at(-1)?.result).toMatchObject({health:'ok',version:'0.2.5',pid:expect.any(Number),createdAt:expect.any(String),nonce:expect.any(String)});
    }finally{await v.cleanup();}
  });
  it('refuses an unrelated HTTP 200 listener as committed restart proof',async()=>{
    const v=await fixture('COMMITTED');const http=await import('node:http');
    const listener=http.createServer((_q,s)=>s.end('{}'));
    await new Promise<void>(r=>listener.listen(v.servicePort,'127.0.0.1',r));
    try {const result=await v.run();expect(result.code).toBe(1);expect(result.output).toMatch(/occupied|port/);const state=await AttemptJournal.inspect(v.root);expect(state.records.some(r=>r.kind==='completion' && typeof (r.result as any)?.nonce==='string')).toBe(false);}
    finally {await new Promise<void>(r=>listener.close(()=>r()));await v.cleanup();}
  });
});
