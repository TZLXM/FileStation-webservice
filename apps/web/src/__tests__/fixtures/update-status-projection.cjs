'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { AttemptJournal } = require(path.resolve(__dirname, '../../../../updater/dist/state/attempt-journal.js'));
const { UpdateStatusService } = require(path.resolve(__dirname, '../../../../server/dist/maintenance/update-status.service.js'));
const { UpdateStatusController } = require(path.resolve(__dirname, '../../../../server/dist/maintenance/update-status.controller.js'));
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'filestation-web-projection-'));
  try {
    const result = {};
    for (const [name, phase, fence] of [['maintenance','MAINTENANCE',2], ['handoff','OLD_STOPPED',3], ['committed','COMMITTED',3], ['rolledBack','ROLLED_BACK',3]]) {
      const dir = path.join(root,name);
      const journal = await AttemptJournal.open(dir);
      await journal.beginAttempt({ attemptId:'attempt-01',fence,currentVersion:'0.2.0',targetVersion:'0.2.5',backupId:'projection',phase,owner:{bootIdentity:'projection-boot',pid:process.pid,processCreatedAt:'projection-created',heartbeatAt:new Date().toISOString()} });
      process.env.FILESTATION_INSTALL_ROOT=dir;
      const controller = new UpdateStatusController(new UpdateStatusService(), {getCachedStatus:()=>({available_version:null,current_version:'0.2.0'})});
      result[name]=await controller.getStatus();
    }
    process.stdout.write(JSON.stringify(result));
  } finally { await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
