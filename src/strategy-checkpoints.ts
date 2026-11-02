import type {Entry} from './actions/ledger.js';
import {gameMinutes} from './game-clock.js';

type Obj = Record<string, any>;
const obj = (value: unknown): Obj => value && typeof value === 'object' ? value as Obj : {};
const percentage = (value: unknown) => typeof value === 'string' && /^(?:100|\d{1,2})(?:\.\d+)?%$/u.test(value)
  && Number(value.slice(0, -1)) <= 100 ? Number(value.slice(0, -1)) : null;
const verdicts = new Set(['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'UKE']);

// Public observation counters, not internal rage or submission-time preparation.
// Switching problems or losing visibility resets the preparation window.
export class StrategyWatch {
  private seen = new Set<string>();
  private failures = new Map<string, number>();
  private freshJudgement: string | null = null;
  private prep: {problem_id: string; values: number[]; since: number; last: number} | null = null;
  constructor(entries: Entry[], runId: string | null) {
    if (!runId) return;
    for (const entry of entries) {
      for (const key of ['before', 'after'] as const) {
        const view = obj(entry[key]);
        if (view.run_id === runId) this.observe(view);
      }
      if (entry.kind === 'confirmed' && entry.tool === 'vcpc_reveal_judgement' && obj(entry.after).run_id === runId)
        this.judgement(entry.action_id, obj(entry.after).dialog);
    }
    this.freshJudgement = null;
  }
  judgement(id: string, value: unknown) {
    if (this.seen.has(id)) return;
    const dialog = obj(value);
    if (typeof dialog.problem_id !== 'string' || !verdicts.has(dialog.result)) return;
    this.seen.add(id);
    this.freshJudgement = dialog.problem_id;
    this.failures.set(dialog.problem_id, dialog.result === 'AC' ? 0 : (this.failures.get(dialog.problem_id) ?? 0) + 1);
  }
  observe(value: unknown) {
    const view = obj(value), contest = obj(view.contest), current = obj(contest.current_problem);
    const selected = contest.selected_problem === undefined ? current.id : contest.selected_problem;
    const elapsed = gameMinutes(contest.elapsed);
    const values = ['insight', 'code', 'testing'].map(key => percentage(current[key]));
    if (!['contest_running', 'contest_paused', 'judge_pending', 'judge_revealed', 'event_choice', 'event_result'].includes(view.phase)
      || typeof selected !== 'string' || selected !== current.id || elapsed === null || values.some(v => v === null)) {
      this.prep = null;
      return;
    }
    const known = values as number[];
    if (!this.prep || this.prep.problem_id !== selected || elapsed < this.prep.last
      || known.some((v, i) => v !== this.prep!.values[i])) {
      this.prep = {problem_id: selected, values: known, since: elapsed, last: elapsed};
    } else this.prep.last = elapsed;
  }
  checkpoint(view: unknown, failureLimit?: number, stallMinutes?: number) {
    const contest = obj(obj(view).contest);
    const current = contest.selected_problem === undefined ? obj(contest.current_problem).id : contest.selected_problem;
    // Let the normal batch collect a newly revealed card before stopping.
    if (obj(view).phase !== 'judge_revealed' && failureLimit !== undefined) {
      for (const id of new Set([this.freshJudgement, current])) {
        if (typeof id === 'string' && (this.failures.get(id) ?? 0) >= failureLimit)
          return {reason: 'failure_streak', problem_id: id, observed_failures: this.failures.get(id)!};
      }
    }
    if (stallMinutes !== undefined && this.prep && this.prep.last - this.prep.since >= stallMinutes)
      return {reason: 'preparation_stall', problem_id: this.prep.problem_id,
        unchanged_for_game_minutes: this.prep.last - this.prep.since, preparation: this.prep.values};
  }
  summary() {
    return {failure_streaks_observed: [...this.failures].map(([problem_id, count]) => ({problem_id, count})),
      preparation_window: this.prep ? {problem_id: this.prep.problem_id,
        unchanged_for_game_minutes: this.prep.last - this.prep.since, since_elapsed_minutes: this.prep.since} : null,
      note: 'Visible observations only; failure counts are not internal rage. Preparation is not measured at submission time.'};
  }
}
