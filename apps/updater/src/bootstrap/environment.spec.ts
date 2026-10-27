import { parse as parseDotenv } from "dotenv";
import { renderManagedEnv, planProductionEnvironment, requireProductionEnvironment } from "./environment";

describe("C46-3 dotenv canonical path serialization",()=>{
 it.each(["C:\\archive#kept\\db.sqlite", "C:\\new\\temp\\db.sqlite", " /fixture/ spaced # path / ", "/fixture/single'and\"double", "/fixture/back`tick"]) ("round-trips approved path %s",value=>{
  const parsed=parseDotenv(renderManagedEnv("JWT_SECRET=fixture-only\n",{database:value,storage:value+"-storage",temp:value+"-temp"}));
  expect(parsed.FILESTATION_DB_PATH).toBe(value); expect(parsed.FILESTATION_STORAGE_PATH).toBe(value+"-storage"); expect(parsed.FILESTATION_TEMP_PATH).toBe(value+"-temp"); expect(parsed.JWT_SECRET).toBe("fixture-only");
 });
 it.each(["/fixture/new\nline","/fixture/return\rvalue","/fixture/control\u0000value","/fixture/tab\tvalue","/fixture/all'\"`quotes"]) ("rejects unsupported paths without echoing them",value=>{
  expect(()=>renderManagedEnv(undefined,{database:value,storage:"/storage",temp:"/temp"})).toThrow(/dotenv|control|represent/i);
 });
});


describe("C46-2 secure production environment resolution",()=>{
 const values={NODE_ENV:"production",JWT_SECRET:"fixture-only-private-value"};
 it("accepts the required restricted dotenv values without copying process-only fields",()=>{
  expect(planProductionEnvironment(values,values)).toEqual({nodeEnv:"production",required:["NODE_ENV","JWT_SECRET"],source:"dotenv"});
 });
 it("preserves process precedence and requires resolution when it overrides dotenv",()=>{
  expect(()=>planProductionEnvironment(values,{...values,JWT_SECRET:"fixture-other-value"})).toThrow(/Secure migration required.*JWT_SECRET/);
  expect(()=>planProductionEnvironment({},values,"dotenv")).toThrow(/Secure migration required/);
  const requirements=planProductionEnvironment({},values,"service");
  expect(requirements?.source).toBe("service");expect(JSON.stringify(requirements)).not.toContain(values.JWT_SECRET);
  expect(()=>requireProductionEnvironment(values,requirements,values)).not.toThrow();
 });
 it("does not include secret values in missing or migration errors",()=>{
  try{planProductionEnvironment({},values);}catch(error){expect(String(error)).not.toContain(values.JWT_SECRET);}
  expect(()=>requireProductionEnvironment({NODE_ENV:"production",JWT_SECRET:"  "})).toThrow(/JWT_SECRET is required/);
 });
});

it("C46-3 refuses path rewriting that would alter an unrelated multiline secret",()=>{
 const original='JWT_SECRET="fixture-multiline\nFILESTATION_DB_PATH=inside-secret\nend"\nFILESTATION_DB_PATH=/old-db\n';
 expect(()=>renderManagedEnv(original,{database:"/approved-db",storage:"/storage",temp:"/temp"})).toThrow(/preserv/i);
});
