"""Curate shared visible-event evidence from an explicit set of real ledgers.

Default is read-only. --apply updates only the shared catalog/manifest; no
controller, browser, profile lock, save, or source ledger is opened for writing.
"""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'vcpc-mcp'
CATALOG = PACKAGE / 'knowledge/events.v1.json'
OUT = ROOT / 'data/vcpc/shared-event-update-20261102'
SOURCES = [PACKAGE / 'data/phase3/actions.jsonl'] + [
    PACKAGE / 'data/profiles' / alias / 'actions.jsonl' for alias in [
        'cycle-09-1101', 'mcp-verify-1031', 'observable-universe-test-3',
        'observable-universe-test-4', 't4-controls-1101', 'visible-08-final',
        'world-finals-test-1', 'world-finals-test-2']]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def norm(s):
    return ' '.join(s.split())


def variant(title, options):
    return (norm(title), tuple(map(norm, options)))


def identity(obs):
    if obs.get('run_id') and obs.get('action_id'):
        return ('mcp', obs['run_id'], obs['action_id'])
    return ('event', obs.get('source'), obs.get('event_id'))


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def sync(apply=False):
    original = CATALOG.read_bytes()
    catalog = json.loads(original)
    before_events = catalog['events']
    before_titles = {norm(e['title']) for e in before_events}
    before_variants = {variant(e['title'], e['options']) for e in before_events}
    before_branches = {(variant(e['title'], e['options']), norm(o['chosen_label']))
                       for e in before_events for o in e['observations']}
    initial_observations = sum(len(e['observations']) for e in before_events)
    evidence_files = {}
    records, by_action, source_stats, source_raw = [], {}, [], {}
    for source in SOURCES:
        raw = source.read_bytes()
        if raw and not raw.endswith(b'\n'):
            raise ValueError(f'incomplete_source: {source.relative_to(ROOT)}')
        source_raw[source] = raw
        source_digest = digest(raw)
        rows = [dict(json.loads(line), _line=i, _line_sha256=digest(line))
                for i, line in enumerate(raw.splitlines(), 1) if line]
        begins = {}
        for row in rows:
            if row.get('kind') == 'begin':
                if row['action_id'] in begins:
                    raise ValueError('duplicate_begin_action')
                begins[row['action_id']] = row
        imported, skipped, seen = 0, Counter(), set()
        for row in rows:
            if row.get('kind') != 'confirmed' or row.get('tool') != 'vcpc_choose_event':
                continue
            if row['action_id'] in seen:
                continue
            seen.add(row['action_id'])
            begin = begins.get(row['action_id'], {})
            before, after = begin.get('before') or {}, row.get('after') or {}
            choice, result = before.get('dialog') or {}, after.get('dialog') or {}
            options = choice.get('options') or []
            args = json.loads(row['args'])
            selected = [o['label'] for o in options if o.get('option_id') == args.get('option_id')]
            if (begin.get('tool') != row['tool'] or begin.get('args') != row['args']
                    or before.get('phase') != 'event_choice' or after.get('phase') != 'event_result'
                    or not choice.get('title') or not result.get('result') or len(selected) != 1
                    or not after.get('run_id') or before.get('run_id') != after.get('run_id')):
                skipped['incomplete_confirmed_pair'] += 1
                continue
            observation = {
                'chosen_label': selected[0], 'outcome_text': result['result'],
                'visible_effects': result.get('effects') or [],
                'source': source.relative_to(PACKAGE).as_posix(),
                'action_id': row['action_id'], 'run_id': after['run_id'], 'observed_at': row['at'],
                'raw_labels': {'title': choice['title'], 'options': [o['label'] for o in options]},
                'ledger_evidence': {'source_sha256': source_digest, 'begin_line': begin['_line'],
                                    'confirmed_line': row['_line'], 'begin_line_sha256': begin['_line_sha256'],
                                    'confirmed_line_sha256': row['_line_sha256']}}
            record = {'title': choice['title'], 'options': observation['raw_labels']['options'],
                      'observation': observation}
            if row['action_id'] in by_action:
                raise ValueError('cross_source_action_collision')
            records.append(record)
            by_action[row['action_id']] = record
            imported += 1
        source_stats.append({'source': source.relative_to(PACKAGE).as_posix(), 'sha256': source_digest,
                             'rows': len(rows), 'confirmed_events': imported, 'skipped': dict(skipped)})

    # Reconcile existing dataset exports with their original MCP actions. This
    # preserves old evidence and prevents counting the export as another event.
    linked = 0
    for event in catalog['events']:
        for obs in event['observations']:
            evidence = obs.get('evidence') or {}
            dom = evidence.get('dom_path')
            if not dom:
                continue
            file = (ROOT / obs['source']).parent / dom
            raw = file.read_bytes()
            if digest(raw) != evidence.get('dom_sha256'):
                raise ValueError(f'evidence_hash_mismatch: {file.relative_to(ROOT)}')
            evidence_files[file.relative_to(ROOT).as_posix()] = digest(raw)
            if file.suffix != '.json' or obs.get('action_id'):
                continue
            exported = json.loads(raw)
            aid = (exported.get('arguments') or exported.get('args') or {}).get('action_id')
            if not aid:
                continue
            record = by_action[aid]
            current = record['observation']
            if (variant(event['title'], event['options']) != variant(record['title'], record['options'])
                    or norm(obs['chosen_label']) != norm(current['chosen_label'])
                    or norm(obs['outcome_text']) != norm(current['outcome_text'])):
                raise ValueError('export_action_mismatch')
            obs.update({k: current[k] for k in ['action_id', 'run_id', 'raw_labels', 'ledger_evidence']})
            if not obs.get('visible_effects'):
                obs['visible_effects'] = current['visible_effects']
            linked += 1

    groups = {variant(e['title'], e['options']): e for e in catalog['events']}
    seen = {identity(o) for e in catalog['events'] for o in e['observations']}
    added = 0
    for record in records:
        obs = record['observation']
        if identity(obs) in seen:
            continue
        key = variant(record['title'], record['options'])
        if key not in groups:
            encoded = json.dumps([key[0], key[1]], ensure_ascii=False, separators=(',', ':')).encode()
            event = {'event_key': digest(encoded)[:16], 'title': record['title'],
                     'options': record['options'], 'observations': []}
            catalog['events'].append(event)
            groups[key] = event
        groups[key]['observations'].append(obs)
        seen.add(identity(obs))
        added += 1
    after_titles = {norm(e['title']) for e in catalog['events']}
    after_branches = {(variant(e['title'], e['options']), norm(o['chosen_label']))
                      for e in catalog['events'] for o in e['observations']}
    catalog['revision'] = catalog.get('revision', 1) + int(bool(added or linked))
    catalog['scope'] = 'Historical visible observations curated from existing playtest datasets and confirmed game ledgers; not probabilities, optimal choices, or automatic authorization.'
    result = {'schema_version': 1, 'catalog_revision': catalog['revision'],
              'before': {'titles': len(before_titles), 'variants': len(before_variants), 'observations': initial_observations},
              'after': {'titles': len(after_titles), 'variants': len(groups), 'observations': len(seen)},
              'new_titles': sorted(after_titles - before_titles),
              'newly_observed_option_branches': len(after_branches - before_branches),
              'new_observations': added, 'old_exports_linked_to_original_actions': linked,
              'sources': source_stats, 'checked_original_evidence_files': len(evidence_files),
              'original_evidence_sha256': evidence_files,
              'new_event_details': [{
                  'title': norm(e['title']), 'options': e['options'],
                  'observations': len(e['observations']),
                  'chosen_branches': dict(Counter(norm(o['chosen_label']) for o in e['observations']))}
                  for e in catalog['events'] if norm(e['title']) in after_titles - before_titles]}
    for source, raw in source_raw.items():
        if source.read_bytes() != raw:
            raise ValueError('source_changed_during_sync')
    if CATALOG.read_bytes() != original:
        raise ValueError('catalog_changed_during_sync')
    if apply:
        OUT.mkdir(parents=True, exist_ok=True)
        backup = OUT / 'events.before.json'
        if not backup.exists():
            backup.write_bytes(original)
        CATALOG.write_text(dump(catalog))
        result.update({'applied_at': datetime.now(timezone.utc).isoformat(),
                       'catalog_sha256': digest(CATALOG.read_bytes()), 'source_ledgers_unchanged': True})
        # Keep the first import's coverage delta when repeating an already-applied sync.
        report = OUT / 'sync-report.json'
        if added or not report.exists():
            report.write_text(dump(result))
        (PACKAGE / 'knowledge/events.manifest.json').write_text(dump({
            'schema_version': 1, 'catalog_revision': catalog['revision'], 'catalog_sha256': result['catalog_sha256'],
            'coverage': result['after'], 'source_ledgers': source_stats,
            'deduplication': 'A run_id/action_id identifies the same MCP event across its original ledger and exported datasets.'}))
    print(dump({k: result[k] for k in ['before', 'after', 'new_titles', 'newly_observed_option_branches',
                                      'new_observations', 'old_exports_linked_to_original_actions']}))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    sync(parser.parse_args().apply)
