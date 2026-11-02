import {createHash} from 'node:crypto';

export function eventObservationId(observation: {
  source?: string; event_id?: string; action_id?: string; run_id?: string;
}) {
  // A saved export and its source ledger are the same event. Paths may be
  // relative in the bundled catalog and absolute in a connected profile.
  if (observation.run_id && observation.action_id)
    return 'mcp:' + createHash('sha256').update(JSON.stringify([observation.run_id, observation.action_id])).digest('hex');
  if (observation.event_id) return `event:${observation.source}:${observation.event_id}`;
  if (observation.action_id) return `action:${observation.source}:${observation.action_id}`;
  return 'content:' + createHash('sha256').update(JSON.stringify(observation)).digest('hex');
}
