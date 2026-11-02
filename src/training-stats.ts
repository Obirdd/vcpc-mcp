type Obj = Record<string, any>;
type Coverage = {expected_cards: number; observed_cards: number; zero_delta_cards: number | null;
  complete: boolean; issue: string | null};
export function trainingCardCoverage(view: Obj, cost: number, delta: number): Coverage {
  const dialog = view.dialog ?? {};
  let deltas: number[] = [];
  if (cost === 10 && Array.isArray(dialog.effects)) {
    for (let i = 0; i + 3 < dialog.effects.length; i++) {
      if (['N', 'R', 'SR', 'SSR', 'UR'].includes(dialog.effects[i])
        && typeof dialog.effects[i + 3] === 'string' && /^[+-]?\d+$/u.test(dialog.effects[i + 3]))
        deltas.push(Number(dialog.effects[i + 3]));
    }
  } else if (cost === 1 && typeof dialog.result === 'string') {
    const match = dialog.result.trim().match(/^([+-]?\d+)\s*RATING$/iu);
    if (match) deltas = [Number(match[1])];
  }
  const valid = deltas.length === cost && deltas.every(Number.isSafeInteger)
    && deltas.reduce((sum, n) => sum + n, 0) === delta;
  return {expected_cards: cost, observed_cards: valid ? cost : 0,
    zero_delta_cards: valid ? deltas.filter(n => n === 0).length : null, complete: valid,
    issue: valid ? null : deltas.length ? 'receipt_count_or_sum_mismatch' : 'card_deltas_unavailable'};
}
export type TrainingRecord = {cost_tp: number; rating_before: number; rating_delta: number; card_coverage: Coverage};
export function trainingWindow(records: TrainingRecord[]) {
  const expected = records.reduce((sum, r) => sum + r.card_coverage.expected_cards, 0);
  const observed = records.reduce((sum, r) => sum + r.card_coverage.observed_cards, 0);
  const zeros = records.reduce((sum, r) => sum + (r.card_coverage.zero_delta_cards ?? 0), 0);
  return {draws: records.length, spent_tp: records.reduce((s, r) => s + r.cost_tp, 0),
    rating_delta: records.reduce((s, r) => s + r.rating_delta, 0),
    positive_draws: records.filter(r => r.rating_delta > 0).length,
    negative_draws: records.filter(r => r.rating_delta < 0).length,
    zero_delta_draws: records.filter(r => r.rating_delta === 0).length,
    card_coverage: {expected_cards: expected, observed_cards: observed,
      zero_delta_cards_observed: observed ? zeros : null,
      zero_delta_fraction_of_observed_cards: observed ? zeros / observed : null,
      complete: expected === observed, conflicting_receipts: records.filter(r => r.card_coverage.issue === 'receipt_count_or_sum_mismatch').length}};
}
export function trainingBands(records: TrainingRecord[]) {
  const edges = [3000, 3500, 3800, 3900, 3950, 4000];
  return [...edges, null].flatMap((high, i) => {
    const low = i ? edges[i - 1] : null;
    const group = records.filter(r => (low === null || r.rating_before >= low) && (high === null || r.rating_before < high));
    if (!group.length) return [];
    const stats = trainingWindow(group), tens = group.filter(r => r.cost_tp === 10);
    return [{min_rating: low, max_rating_exclusive: high, ...stats,
      observed_rating_per_tp: stats.spent_tp ? stats.rating_delta / stats.spent_tp : null,
      ten_draws: tens.length,
      mean_rating_delta_per_ten: tens.length ? tens.reduce((s, r) => s + r.rating_delta, 0) / tens.length : null}];
  });
}
