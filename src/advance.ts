import {createHash} from 'node:crypto';
import {z} from 'zod/v4';
import type {Tool, View} from './actions/controller.js';
import type {Ledger} from './actions/ledger.js';
import {eventKnowledge} from './knowledge.js';
import {gameMinutes} from './game-clock.js';
import {StrategyWatch} from './strategy-checkpoints.js';

export const normalizeWhitespace = (s: string) => s.replace(/\s+/gu, ' ').trim();
export const EventRule = z.object({title: z.string().min(1), options: z.array(z.string().min(1)).min(1),
  choose: z.string().min(1), matching: z.enum(['exact', 'whitespace']).optional()}).strict().refine(r => {
  const norm = r.matching === 'whitespace' ? normalizeWhitespace : (s: string) => s;
  const labels = r.options.map(norm);
  return new Set(labels).size === labels.length && labels.filter(o => o === norm(r.choose)).length === 1;
}, 'choose and ordered options must remain unique under the authorized matching mode');

export const AdvanceOptions = z.object({
  max_steps: z.number().int().min(1).max(100).default(40),
  timeout_ms: z.number().int().min(1000).max(30000).default(20000),
  auto_judgements: z.boolean().default(true), continue_event_results: z.boolean().default(true),
  event_rules: z.array(EventRule).max(100).default([]),
  target_speed: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  stop_after_judgements: z.number().int().min(1).max(50).optional(),
  stop_at_elapsed_minutes: z.number().int().min(0).max(300).optional(),
  stop_on_failure_streak: z.number().int().min(1).max(50).optional(),
  stop_on_preparation_stall_minutes: z.number().int().min(1).max(300).optional(),
  pause_at_checkpoint: z.boolean().optional(),
  pause_drain_limit: z.number().int().min(0).max(5).optional(),
  policy: z.object({policy_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    version: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)}).strict().optional()
}).strict();
export type AdvanceOptions = z.infer<typeof AdvanceOptions>;
type ActionResult = {status: string; before?: View; after?: View; message?: string};
export type AdvanceIO = {read: () => Promise<View>; execute: (tool: Tool, id: string, args: Record<string, unknown>) => Promise<ActionResult>;
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown>; ledger: Ledger; now?: () => number;
  policy?: {rules: z.infer<typeof EventRule>[]; policy_id: string; version: string; sha256: string; validate: () => void}};
type Checkpoint = {reason: string; problem_id?: string; pause_requested: boolean; paused: boolean;
  pause_blocked_reason: string | null; blocking_phase: string | null; drained_dialogs: number; [key: string]: unknown};

// Each child retains normal checks and logging. Replays observe only; pending
// pause intent never outlives the explicitly bounded batch.
export async function advance(io: AdvanceIO, id: string, options: AdvanceOptions, signal?: AbortSignal) {
  if (options.policy && options.event_rules.length) throw Error('policy_and_inline_rules_conflict');
  if (io.policy && !options.policy) throw Error('policy_not_authorized');
  if (options.policy && (!io.policy || io.policy.policy_id !== options.policy.policy_id || io.policy.version !== options.policy.version)) throw Error('policy_not_resolved');
  if (options.pause_drain_limit && !options.pause_at_checkpoint) throw Error('pause_drain_requires_pause_at_checkpoint');
  const now = io.now ?? Date.now, encoded = JSON.stringify(options);
  const previous = io.ledger.records(id).find(e => e.tool === 'vcpc_advance');
  if (previous) {
    if (previous.args !== encoded) return {status: 'action_id_conflict'};
    return {status: 'batch_replay', observation: await io.read(), message: 'Batch already attempted; no clicks replayed. Inspect action ledger and current state.'};
  }
  if (io.ledger.records(id).length) return {status: 'action_id_conflict'};
  if (io.ledger.unresolved()) return {status: 'outcome_unknown', observation: await io.read()};
  io.ledger.append({at: new Date(now()).toISOString(), kind: 'confirmed', tool: 'vcpc_advance', action_id: id, args: encoded, detail: 'batch_attempted'});
  const deadline = now() + options.timeout_ms;
  const steps: Array<{tool: Tool; action_id: string; status: string; dialog: unknown}> = [];
  let observation = await io.read(), status = 'step_limit', decision: unknown, matchEvidence: unknown;
  const runId = typeof observation.run_id === 'string' ? observation.run_id : null;
  const watching = options.stop_on_failure_streak !== undefined || options.stop_on_preparation_stall_minutes !== undefined;
  const watch = new StrategyWatch(watching ? io.ledger.entries : [], watching ? runId : null);
  watch.observe(observation);
  let collectedJudgements = 0, checkpoint: Checkpoint | undefined;
  const isContest = () => ['contest_running', 'contest_paused', 'judge_pending', 'judge_revealed', 'event_choice', 'event_result'].includes(observation.phase);
  const checkpointTrigger = () => {
    if (!isContest()) return undefined;
    const strategic = watch.checkpoint(observation, options.stop_on_failure_streak, options.stop_on_preparation_stall_minutes);
    if (strategic) return strategic;
    if (options.stop_after_judgements !== undefined && collectedJudgements >= options.stop_after_judgements) return {reason: 'judgement_limit'};
    const elapsed = gameMinutes((observation.contest as {elapsed?: unknown} | null)?.elapsed);
    if (elapsed !== null && options.stop_at_elapsed_minutes !== undefined && elapsed >= options.stop_at_elapsed_minutes) return {reason: 'elapsed_time'};
  };
  const blockPause = (reason: string) => {
    if (checkpoint) {checkpoint.pause_blocked_reason = reason; checkpoint.blocking_phase = observation.phase;}
  };
  while (steps.length < options.max_steps) {
    if (signal?.aborted) {status = 'cancelled'; break;}
    if (now() >= deadline) {status = 'time_limit'; break;}
    let tool: Tool | undefined, args: Record<string, unknown> = {};
    const decision_id = observation.dialog?.decision_id;
    const contest = observation.contest as {speed?: number | null} | null | undefined;
    const trigger = checkpointTrigger();
    if (!checkpoint && trigger) checkpoint = {...trigger, pause_requested: options.pause_at_checkpoint === true,
      paused: observation.phase === 'contest_paused', pause_blocked_reason: null, blocking_phase: null, drained_dialogs: 0};
    let draining = false;
    if (checkpoint && isContest()) {
      checkpoint.paused = observation.phase === 'contest_paused';
      if (!checkpoint.pause_requested || checkpoint.paused) {status = 'checkpoint'; break;}
      if (observation.phase === 'contest_running') {tool = 'vcpc_control_contest'; args = {operation: 'pause'};}
      else {
        const limit = options.pause_drain_limit ?? 0;
        if (observation.phase === 'event_choice') {blockPause('event_choice_requires_decision'); status = 'checkpoint'; break;}
        if (checkpoint.drained_dialogs >= limit) {blockPause(limit ? 'drain_limit_reached' : 'blocked_by_dialog'); status = 'checkpoint'; break;}
        if (['judge_pending', 'judge_revealed'].includes(observation.phase) && !options.auto_judgements) {blockPause('auto_judgements_disabled'); status = 'checkpoint'; break;}
        if (observation.phase === 'event_result' && !options.continue_event_results) {blockPause('continue_event_results_disabled'); status = 'checkpoint'; break;}
        draining = true;
      }
    }
    if (!tool && !checkpoint && options.target_speed && ['contest_running', 'contest_paused'].includes(observation.phase)) {
      if (contest?.speed == null) {status = 'speed_unknown'; break;}
      tool = 'vcpc_control_contest'; args = {operation: 'speed', speed: options.target_speed};
    }
    if (!tool) switch (observation.phase) {
      case 'contest_running':
        await io.wait(Math.min(1000, Math.max(0, deadline - now())), signal);
        observation = await io.read(); watch.observe(observation); continue;
      case 'judge_pending': if (options.auto_judgements) {tool = 'vcpc_reveal_judgement'; args = {decision_id};} break;
      case 'judge_revealed': if (options.auto_judgements) {tool = 'vcpc_collect_judgement'; args = {decision_id};} break;
      case 'event_result': if (options.continue_event_results) {tool = 'vcpc_continue_event'; args = {decision_id};} break;
      case 'event_choice': {
        const title = (observation.dialog as {title?: string})?.title;
        if (options.target_speed) {decision = {match: {reason: 'speed_intent_requires_decision'}, knowledge: title ? eventKnowledge(title, io.ledger.logPath) : null}; break;}
        const labels = observation.dialog?.options?.map(o => o.label) ?? [], rules = io.policy?.rules ?? options.event_rules;
        if (io.policy) {try {io.policy.validate();} catch {status = 'policy_unavailable'; break;}}
        const titleMatches = (r: z.infer<typeof EventRule>) => r.matching === 'whitespace' ? normalizeWhitespace(r.title) === normalizeWhitespace(title ?? '') : r.title === title;
        const matching = rules.filter(r => {const norm = r.matching === 'whitespace' ? normalizeWhitespace : (s: string) => s;
          return titleMatches(r) && JSON.stringify(r.options.map(norm)) === JSON.stringify(labels.map(norm)) && new Set(labels.map(norm)).size === labels.length;});
        const reason = matching.length > 1 ? 'ambiguous' : matching.length === 0 ? rules.some(titleMatches) ? 'options_changed' : 'no_matching_rule' : 'unique_match';
        const match = {reason, matching_rules: matching.length, policy: io.policy ? {policy_id: io.policy.policy_id, version: io.policy.version, sha256: io.policy.sha256} : null};
        decision = {match, knowledge: matching.length !== 1 && title ? eventKnowledge(title, io.ledger.logPath) : null};
        matchEvidence = {...match, title, options: labels, choose: matching.length === 1 ? matching[0].choose : null, matching: matching.length === 1 ? matching[0].matching ?? 'exact' : null, decision_id};
        if (matching.length === 1) {
          const norm = matching[0].matching === 'whitespace' ? normalizeWhitespace : (s: string) => s;
          const option = observation.dialog?.options?.filter(o => norm(o.label) === norm(matching[0].choose));
          if (option?.length === 1) {tool = 'vcpc_choose_event'; args = {decision_id, option_id: option[0].option_id};}
        }
        break;
      }
    }
    if (!tool) {if (status === 'policy_unavailable') break; status = observation.phase === 'final' ? 'final' : observation.phase === 'event_choice' ? 'decision_required' : 'stopped'; break;}
    if (!decision_id && tool !== 'vcpc_control_contest') {status = 'missing_decision'; break;}
    const child = `advance-${createHash('sha256').update(id).digest('hex').slice(0, 24)}-${steps.length}`;
    if (signal?.aborted) {status = 'cancelled'; break;}
    if (now() >= deadline) {status = 'time_limit'; break;}
    if (tool === 'vcpc_choose_event' && io.policy) {try {io.policy.validate();} catch {status = 'policy_unavailable'; break;}}
    const before = observation, result = await io.execute(tool, child, args);
    steps.push({tool, action_id: child, status: result.status,
      dialog: tool === 'vcpc_reveal_judgement' || tool === 'vcpc_choose_event' ? result.after?.dialog : before.dialog,
      ...(tool === 'vcpc_choose_event' ? {match: matchEvidence, actual_option_id: args.option_id} : {})});
    if (result.status !== 'confirmed' && result.status !== 'already_satisfied') {
      observation = result.after ?? result.before ?? await io.read(); watch.observe(observation);
      const racedDialog = tool === 'vcpc_control_contest' && ['blocked_by_dialog', 'invalid_phase'].includes(result.status)
        && ['judge_pending', 'judge_revealed', 'event_result', 'event_choice'].includes(observation.phase);
      if (racedDialog && (checkpoint || options.target_speed)) continue;
      status = result.status; break;
    }
    // Use the controller's confirmed snapshot, avoiding another browser round
    // trip before attempting a pause in a brief clear window.
    observation = result.after ?? await io.read(); watch.observe(observation);
    if (tool === 'vcpc_reveal_judgement') watch.judgement(child, observation.dialog);
    if (tool === 'vcpc_collect_judgement') collectedJudgements++;
    if (checkpoint && draining && ['vcpc_collect_judgement', 'vcpc_continue_event'].includes(tool)) checkpoint.drained_dialogs++;
    if (checkpoint && tool === 'vcpc_control_contest' && args.operation === 'pause') {
      checkpoint.paused = observation.phase === 'contest_paused';
      if (checkpoint.paused) {status = 'checkpoint'; break;}
      blockPause('pause_not_confirmed'); status = 'checkpoint'; break;
    }
    if (tool === 'vcpc_control_contest' && args.operation === 'speed' && options.target_speed) {
      status = (observation.contest as {speed?: number | null} | null)?.speed === options.target_speed
        ? result.status === 'already_satisfied' ? 'speed_satisfied_no_click' : 'speed_confirmed' : 'speed_not_persistent'; break;
    }
  }
  if (observation.phase === 'final' && status === 'step_limit') status = 'final';
  if (status === 'step_limit' && !checkpoint) {
    const trigger = checkpointTrigger();
    if (trigger) {checkpoint = {...trigger, pause_requested: options.pause_at_checkpoint === true,
      paused: observation.phase === 'contest_paused', pause_blocked_reason: null, blocking_phase: null, drained_dialogs: 0}; status = 'checkpoint';}
  }
  if (checkpoint?.pause_requested && !checkpoint.paused && !checkpoint.pause_blocked_reason)
    blockPause(observation.phase === 'final' ? 'contest_finished' : status === 'checkpoint' ? 'step_limit' : status);
  const strategy = watching ? watch.summary() : undefined;
  io.ledger.append({at: new Date(now()).toISOString(), kind: 'confirmed', tool: 'vcpc_advance_result', action_id: id, args: encoded,
    after: {run_id: observation.run_id ?? null, phase: observation.phase, identity: observation.identity, contest: observation.contest ?? null},
    detail: JSON.stringify({status, steps, collected_judgements: collectedJudgements, checkpoint, strategy})});
  return {status, steps, observation, collected_judgements: collectedJudgements, ...(checkpoint ? {checkpoint} : {}),
    ...(strategy ? {strategy} : {}), ...(options.target_speed ? {control_intent: {operation: 'speed', target: options.target_speed,
      satisfied: status === 'speed_confirmed' || status === 'speed_satisfied_no_click'}} : {}),
    ...(status === 'decision_required' ? {decision} : {}), evidence_location: io.ledger.logPath};
}
