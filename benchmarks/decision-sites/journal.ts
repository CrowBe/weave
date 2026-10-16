/** Single-writer durable JSONL. No provider diagnostics or secrets enter this boundary. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
export type JournalRecord = Record<string, any>;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
// Reserve one input token per UTF-8 byte rather than an average chars/token ratio.
// Output is free in every declared benchmark price profile.
export const projectedCost = (serialized: string, price: number): number => Buffer.byteLength(serialized, 'utf8') * price / 1e6;
export function replayKey(r: JournalRecord): string {
 return JSON.stringify([r.provider,r.model,r.site,r.item_id,r.set_digest,r.question_digest,r.request_digest]);
}
function writeAll(fd:number,value:string):void {const bytes=Buffer.from(value);let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw new Error('Journal write failed');offset+=n;}}
export class Journal {
 readonly path: string;
 readonly readOnly: boolean;
 constructor(path: string, readOnly=false) { this.path=path; this.readOnly=readOnly; this.read(); }
 read(): JournalRecord[] {
  if(!existsSync(this.path)) return [];
  const bytes=readFileSync(this.path); const lines=bytes.toString('utf8').split('\n');
  const rows: JournalRecord[]=[]; let validBytes=0;
  for(let i=0;i<lines.length;i++) {
   const line=lines[i]!;
   if(!line && i===lines.length-1) break;
   try { rows.push(JSON.parse(line) as JournalRecord); }
   catch { if(i!==lines.length-1) throw new Error('Corrupt journal before final line'); if(!this.readOnly){truncateSync(this.path,validBytes); const fd=openSync(this.path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}} return rows; }
   validBytes+=Buffer.byteLength(line)+(i<lines.length-1?1:0);
  }
  if(!this.readOnly && bytes.length && bytes[bytes.length-1]!==10) {
   const fd=openSync(this.path,'a',0o600); try {writeSync(fd,'\n');fsyncSync(fd);}finally{closeSync(fd);}
  }
  return rows;
 }
 append(record: JournalRecord): void {
  if(this.readOnly)throw new Error('Cannot append to a read-only journal');
  this.read(); const fd=openSync(this.path,'a',0o600);
  try { writeAll(fd,JSON.stringify(record)+'\n');fsyncSync(fd); } finally {closeSync(fd);}
  const directory=openSync(dirname(this.path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
 }
 spent(): number {
  const rows=this.read();const complete=new Set(rows.filter(r=>r.type==='call').map(r=>r.call_id));
  const seen=new Set<string>();let total=0;
  for(const r of rows) {
   if(r.type==='call' && !seen.has(r.call_id)){total+=r.cost_usd??0;seen.add(r.call_id);}
   if(r.type==='intent' && !complete.has(r.call_id)) total+=r.projected_usd??0;
  }
  return total;
 }
}
export function acquireLock(dir: string): ()=>void {
 mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'lock');let fd:number;
 try {fd=openSync(path,'wx',0o600);} catch {
  let state:'locked'|'stale'|'stale-unknown'='stale-unknown';
  try {const text=readFileSync(path,'utf8').trim(),pid=Number(text);if(!/^[1-9][0-9]*$/.test(text)||!Number.isSafeInteger(pid))throw new Error();if(pid===process.pid)state='stale';else{state='locked';process.kill(pid,0);}}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')state='stale';}
  throw new Error(state==='locked'?'Run directory locked':`Run directory has ${state} lock; inspect before removing`);
 }
 try{writeSync(fd,String(process.pid));fsyncSync(fd);}finally{closeSync(fd);}
 // Persist directory entry as well as file contents.
 const directory=openSync(dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
 return ()=>unlinkSync(path);
}
