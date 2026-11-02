import {createHash,randomUUID} from 'node:crypto';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync,readdirSync,linkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod/v4';
import {EventRule} from './advance.js';
export const PolicyKey=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const PolicyRef=z.object({policy_id:PolicyKey,version:PolicyKey}).strict();
export const PolicyDefinition=PolicyRef.extend({rules:z.array(EventRule).max(100)}).strict();
export type PolicyRef=z.infer<typeof PolicyRef>;
export type PolicyDefinition=z.infer<typeof PolicyDefinition>;
// Immutable, operator/client-authored definitions. Naming is validated before path construction.
export class PolicyStore {
 constructor(private readonly dir:string){}
 private root(create=false){const root=path.join(this.dir,'event-policies');if(create){mkdirSync(this.dir,{recursive:true,mode:0o700});if(lstatSync(this.dir).isSymbolicLink())throw Error('unsafe_policy_directory');try{mkdirSync(root,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}if(existsSync(root)&&(!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink()))throw Error('unsafe_policy_directory');return root;}
 private filename(ref:PolicyRef){PolicyRef.parse(ref);return createHash('sha256').update(JSON.stringify([ref.policy_id,ref.version])).digest('hex');}
 private file(ref:PolicyRef){return path.join(this.root(),this.filename(ref)+'.json');}
 private disabled(ref:PolicyRef){return path.join(this.root(),this.filename(ref)+'.disabled');}
 private readFile(p:string){const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
 save(value:PolicyDefinition){const def=PolicyDefinition.parse(value);const body=JSON.stringify(def);this.root(true);const p=this.file({policy_id:def.policy_id,version:def.version}),tmp=path.join(this.root(),`.pending-${randomUUID()}`);let fd:number|undefined;try{fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,body);fsyncSync(fd);closeSync(fd);fd=undefined;try{linkSync(tmp,p);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(this.readFile(p)!==body)throw Error('policy_version_conflict');}}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}return this.get({policy_id:def.policy_id,version:def.version});}
 list(){const root=this.root();let names:string[];try{names=readdirSync(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}return names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(n=>{const p=path.join(root,n);const def=PolicyDefinition.parse(JSON.parse(this.readFile(p)));if(this.filename({policy_id:def.policy_id,version:def.version})+'.json'!==n)throw Error('policy_identity_mismatch');return this.get({policy_id:def.policy_id,version:def.version});});}
 get(ref:PolicyRef){const parsed=PolicyRef.parse(ref);let text:string;try{text=this.readFile(this.file(parsed));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('policy_not_found');throw e;}const definition=PolicyDefinition.parse(JSON.parse(text));if(definition.policy_id!==parsed.policy_id||definition.version!==parsed.version)throw Error('policy_identity_mismatch');return {definition,sha256:createHash('sha256').update(text).digest('hex'),disabled:existsSync(this.disabled(parsed))};}
 disable(ref:PolicyRef){const old=this.get(ref);const p=this.disabled(ref);try{const fd=openSync(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify({policy_id:ref.policy_id,version:ref.version,at:new Date().toISOString(),sha256:old.sha256}));fsyncSync(fd);}finally{closeSync(fd);}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}return this.get(ref);}
}
