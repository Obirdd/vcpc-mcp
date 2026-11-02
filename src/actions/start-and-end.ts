import {createHash} from 'node:crypto';
import type {ActionController,View} from './controller.js';

// Stable child IDs keep a retry on the same run, including when only the start
// completed. This helper never claims rewards or retries an uncertain action.
export async function startAndEnd(controller:ActionController,read:()=>Promise<View>,actionId:string){
  if(!controller.allowEarlyEnd)return {status:'early_end_not_authorized'};
  const id=createHash('sha256').update(actionId).digest('hex').slice(0,40);
  const started=await controller.execute('vcpc_start_contest',`quick-${id}-start`,{});
  if(!['confirmed','confirmed_replay'].includes(started.status))return {status:started.status,started};
  const ended=await controller.execute('vcpc_end_contest',`quick-${id}-end`,{confirm_early_end:true});
  return {status:['confirmed','confirmed_replay'].includes(ended.status)?'confirmed':ended.status,run_id:started.run_id,started,ended,observation:await read()};
}
