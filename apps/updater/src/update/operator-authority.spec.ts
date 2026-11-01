import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OperatorRecoveryAuthority} from './operator-authority';
import {AttemptJournal} from '../state/attempt-journal';
import {NodeDurableFileSystem} from '../platform/durable-fs';
import {context} from '../test-support';

jest.setTimeout(30000);
describe('protected local operator authority',()=>{
  it('requires real OS protection and exact attempt/fence; JS construction and prototype spoofing fail',async()=>{
    const root=await realpath(await mkdtemp(path.join(tmpdir(), 'fs-operator-')));
    try {
      const journal=await AttemptJournal.open(root);
      await journal.beginAttempt(context());
      const fs=new NodeDurableFileSystem();
      await fs.writeAtomic(path.join(root,'managed-install.json'),Buffer.from('{}'),{mode:0o600});
      expect(()=>new (OperatorRecoveryAuthority as any)(root,'attempt-01',1)).toThrow(/protected OS boundary/);
      expect(()=>OperatorRecoveryAuthority.prototype.assert.call(Object.create(OperatorRecoveryAuthority.prototype),root,'attempt-01',1)).toThrow(/mismatched/);
      await expect(OperatorRecoveryAuthority.authorize(root,'wrong-attempt',1)).rejects.toThrow(/attempt\/fence/);
      await expect(OperatorRecoveryAuthority.authorize(root,'attempt-01',2)).rejects.toThrow(/attempt\/fence/);
      const authority=await OperatorRecoveryAuthority.authorize(root,'attempt-01',1);
      expect(()=>authority.assert(root,'attempt-01',1)).not.toThrow();
      expect(()=>authority.assert(root,'attempt-01',2)).toThrow(/mismatched/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
