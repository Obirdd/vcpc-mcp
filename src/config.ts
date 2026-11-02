import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstatSync} from 'node:fs';

// A profile alias determines both browser and ledger paths; they cannot be set independently.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function resolveConfig(env:NodeJS.ProcessEnv=process.env){
  const alias=env.VCPC_PROFILE_ALIAS;
  if(alias!==undefined && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(alias))throw Error('invalid_profile_alias');
  const team=env.VCPC_EXPECTED_TEAM;
  if(alias && (!team || !team.trim() || team.length>100))throw Error('expected_team_required');
  if(!alias && team && team!=='MCP阶段三测试-1030')throw Error('expected_team_requires_profile_alias');
  if(alias){for(const component of [path.join(root,'.profiles'),path.join(root,'.profiles',alias),path.join(root,'data','profiles'),path.join(root,'data','profiles',alias)]){try{if(lstatSync(component).isSymbolicLink())throw Error('unsafe_profile_path');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
  return alias?{root,profile:path.join(root,'.profiles',alias),dir:path.join(root,'data','profiles',alias),expectedTeam:team!.trim()}:{root,profile:path.join(root,'.profile-stage3'),dir:path.join(root,'data','phase3'),expectedTeam:'MCP阶段三测试-1030'};
}

export function playLimits(env:NodeJS.ProcessEnv=process.env){
 const integer=(key:string,fallback:number)=>{const v=env[key];if(v===undefined)return fallback;if(!/^(0|[1-9]\d{0,4})$/.test(v)||Number(v)>10000)throw Error(`invalid_${key}`);return Number(v);};
 return {maxContests:integer('VCPC_MAX_CONTESTS',env.VCPC_PROFILE_ALIAS?2:3),trainingTp:integer('VCPC_TRAINING_TP_BUDGET',0)};
}
