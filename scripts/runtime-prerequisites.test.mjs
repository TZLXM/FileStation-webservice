import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const original=JSON.parse(await readFile(path.join(repository,"package.json"),"utf8"));
const compiler=path.join(repository,"node_modules/typescript/bin/tsc");
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),"filestation-prereqs-"));
 await writeFile(path.join(root,"package.json"),JSON.stringify({...original,overrides:undefined,devDependencies:{}}));
 const projects=[["packages/shared","shared",undefined],["packages/update-core","update-core","shared"],["apps/updater","updater","update-core"],["apps/server","server","updater"],["apps/web","web",undefined]];
 for(const [folder,name,dependency] of projects) {
  const dir=path.join(root,folder); await mkdir(path.join(dir,"src"),{recursive:true});
  await writeFile(path.join(dir,"package.json"),JSON.stringify({name:`@filestation/${name}`,version:"0.2.0",main:"dist/index.js",types:"dist/index.d.ts",scripts:{build:`node "${compiler}" -p tsconfig.json`,typecheck:`node "${compiler}" -p tsconfig.json --noEmit`}}));
  await writeFile(path.join(dir,"tsconfig.json"),JSON.stringify({compilerOptions:{module:"commonjs",moduleResolution:"node",target:"ES2022",declaration:true,rootDir:"src",outDir:"dist",strict:true,types:[]},include:["src"]}));
  await writeFile(path.join(dir,"src/index.ts"),dependency?`import { value as upstream } from '@filestation/${dependency}'; export const value: number = upstream + 1;`:"export const value: number = 1;");
  await mkdir(path.join(root,"node_modules/@filestation"),{recursive:true});
  await symlink(dir,path.join(root,"node_modules/@filestation",name),process.platform==="win32"?"junction":"dir");
 }
 return root;
}
function run(root,script) {
 const npm=process.env.npm_execpath ?? path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js");
 return spawnSync(process.execPath,[npm,"run",script],{cwd:root,encoding:"utf8",windowsHide:true,timeout:120000});
}
async function clean(root) { assert.ok(root.startsWith(tmpdir()+path.sep)&&path.basename(root).startsWith("filestation-prereqs-")); await rm(root,{recursive:true,force:true}); }
for(const script of ["typecheck","dev:prepare"]) test(`fresh ${script} emits prerequisite packages without any preceding dist`,async()=>{
 const root=await fixture();try {
  for(const dir of ["packages/shared","packages/update-core","apps/updater"]) await assert.rejects(access(path.join(root,dir,"dist")),{code:"ENOENT"});
  const result=run(root,script);assert.equal(result.status,0,result.stdout+result.stderr);
  for(const dir of ["packages/shared","packages/update-core","apps/updater"]) for(const file of ["index.js","index.d.ts"]) await access(path.join(root,dir,"dist",file));
  const runtime=spawnSync(process.execPath,["-e","require('node:assert/strict').equal(require('@filestation/updater').value,3)"],{cwd:root,encoding:"utf8",windowsHide:true});
  assert.equal(runtime.status,0,runtime.stderr);
  if(script==="dev:prepare") assert.match(original.scripts.dev,/^npm run dev:prepare &&/);
 }finally{await clean(root);}
});
