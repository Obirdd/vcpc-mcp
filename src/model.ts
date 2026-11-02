import { z } from 'zod/v4';

export const Phase = z.enum(['registration','initial_rating','lobby','rules','strategy','contest_running','contest_paused','event_choice','event_result','judge_pending','judge_revealed','final','training','training_result','end_confirmation','unknown']);
export const Observation = z.object({
  schema_version: z.literal('vcpc-mcp.v1'), session_id: z.string(), run_id: z.string().nullable(), snapshot_id: z.string(), observed_at: z.string(), phase: Phase,
  blocking_dialog: z.string().nullable(),
  identity: z.object({team_name:z.string().nullable(), season:z.number().int().nullable(), stage:z.string().nullable(), rating:z.number().int().nullable(), tp:z.number().int().nullable()}),
  competition: z.object({stage:z.string().nullable(),source:z.enum(['precontest_title','result_heading','unverified']),title:z.string().nullable(),topbar_stage:z.string().nullable(),field_intel:z.string().nullable()}).optional(),
  strategy_details:z.array(z.object({name:z.string(),description:z.string().nullable(),rule:z.string().nullable(),modifiers:z.array(z.string()),selected:z.boolean()})).nullable().optional(),
  run_context:z.object({run_id:z.string(),season:z.number().int().nullable(),stage:z.string().nullable(),stage_source:z.string(),strategy:z.string().nullable(),rating_before:z.number().int().nullable(),tp_before:z.number().int().nullable(),start_confirmed:z.boolean()}).nullable().optional(),
  contest: z.object({elapsed:z.string().nullable(), remaining:z.string().nullable(), elapsed_minutes:z.number().int().nonnegative().nullable().optional(),remaining_minutes:z.number().int().nonnegative().nullable().optional(),time_unit:z.literal('game_minutes').optional(),clock_format:z.literal('H:MM').optional(),selected_problem:z.string().nullable().optional(), speed:z.union([z.literal(1),z.literal(2),z.literal(4)]).nullable().optional(), playback:z.enum(['running','paused']).nullable().optional(), team:z.object({stamina:z.string().nullable(),morale:z.string().nullable()}).optional(), current_problem:z.object({id:z.string().nullable(),insight:z.string().nullable(),code:z.string().nullable(),testing:z.string().nullable()}).optional()}).nullable(),
  problems: z.array(z.object({id:z.string(), title:z.string().nullable(), status:z.string().nullable()})).nullable(),
  strategy_options: z.array(z.string()).nullable(),
  final: z.object({rank:z.string().nullable(), facts:z.array(z.string()),stage:z.string().nullable().optional(),heading:z.string().nullable().optional(),medal:z.enum(['gold','silver','bronze']).nullable().optional(),review_text:z.string().nullable().optional(),standings_text:z.string().nullable().optional(),verdicts:z.array(z.object({verdict:z.string(),count:z.number().int().nullable()})).optional(),rating:z.array(z.string()).optional(),reward:z.string().nullable().optional(),review_status:z.enum(['pending','claimed','not_offered','unknown']).optional()}).nullable(),
  dialog: z.object({type:z.string(),title:z.string().nullable(),text:z.string().nullable(),problem_id:z.string().nullable().optional(),submitted_at:z.string().nullable().optional(),options:z.array(z.union([z.string(),z.object({option_id:z.string(),label:z.string()})])).nullable(),decision_id:z.string().nullable().optional(),result:z.string().nullable(),effects:z.array(z.string()).nullable()}).nullable(),
  training: z.object({cost_tp:z.literal(1).nullable(),can_draw:z.boolean(),cost_ten_tp:z.literal(10).nullable().optional(),can_draw_ten:z.boolean().optional(),result:z.string().nullable(),budget_remaining_tp:z.number().int().nullable().optional()}).nullable().optional(),
  allowed_actions: z.array(z.string()), uncertainties: z.array(z.string()), evidence: z.array(z.string())
}).strict();
export type Observation = z.infer<typeof Observation>;
export type PageSnapshot = Omit<Observation,'schema_version'|'session_id'|'snapshot_id'|'observed_at'|'run_id'|'allowed_actions'>;
