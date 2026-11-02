// Public game clocks use hours:minutes, independently of wall-clock tool budgets.
export function gameMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/^(?:已用|剩余)\s*/u, '').match(/^(\d+):([0-5]\d)$/u);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isSafeInteger(minutes) ? minutes : null;
}
