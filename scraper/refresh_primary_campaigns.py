"""Build reviewed primary-campaign exclusions from election results and cash receipts.

Read-only database access. Publish through a PR; never update application tables.
Historical receipts remain intact. Missing/ambiguous candidate matches are skipped.
"""
import json
import re
import statistics
import unicodedata
from datetime import date, timedelta
from pathlib import Path

OUTPUT = Path(__file__).resolve().parents[1] / 'docs/assets/primary_campaign_exclusions.json'
RULE = {'minimum_opposition_pct': 20, 'minimum_cash': 25000,
        'minimum_increase': 10000, 'historical_multiple': 1.5,
        'prior_periods': 2}


def primary_date(year):
    first = date(year, 5, 1)
    return first + timedelta(days=(1 - first.weekday()) % 7 + 14)


def tokens(name):
    text = unicodedata.normalize('NFKD', name or '').encode('ascii', 'ignore').decode().lower()
    return {t for t in re.findall('[a-z]+', text) if len(t) > 1 and t not in {'jr', 'sr', 'ii', 'iii'}}


def matches(filer, candidate):
    other = tokens(candidate)
    return len(other) >= 2 and any(len(own & other) >= 2 and (own <= other or other <= own)
        for own in (tokens(filer.get('candidate_name')), tokens(filer.get('name'))))


def qualifies(total, previous, opposition):
    # Require evidence of two funded prior periods; zero/missing history is not
    # evidence of a fundraising surge. Entry-primary handling is separate.
    if len(previous) != 2 or any(value <= 0 for value in previous):
        return False
    baseline = statistics.median(previous)
    return (opposition >= RULE['minimum_opposition_pct']
            and total >= RULE['minimum_cash']
            and total >= baseline * RULE['historical_multiple']
            and total - baseline >= RULE['minimum_increase'])


def build(filers, elections, totals, today=None):
    today = today or date.today()
    races = {}
    # Some source rows retain a party header in the candidate cell instead of
    # ballot_party. Carry that explicit header through its ordered race block.
    block, override, previous_party = None, None, None
    for source in sorted(elections, key=lambda r: r.get('id', 0)):
        row = dict(source)
        current = (int(row['year']), row['office_normalized'], row['district'])
        if current != block or row['ballot_party'] != previous_party:
            override = None
        block, previous_party = current, row['ballot_party']
        header = re.match(r'^(Republican|Democrat|Independent)\s+\*(.*)$', row['candidate'])
        if header:
            override, row['candidate'] = header.groups()
        if override:
            row['ballot_party'] = override
        key = (int(row['year']), row['office_normalized'], row['district'], row['ballot_party'])
        races.setdefault(key, []).append(row)
    exclusions = []
    for filer in filers:
        if filer.get('office') not in ('State Representative', 'State Senator'):
            continue
        ids = sorted(set(map(str, filer.get('filer_ids') or [filer['filer_id']])))
        for (year, office, district, party), rows in races.items():
            if primary_date(year) >= today or party != filer.get('party'):
                continue
            # Ambiguous/incomplete party grouping must not flag a campaign.
            if not 98 <= sum(float(r['pct']) for r in rows) <= 102:
                continue
            named = [r for r in rows if not re.search(r'misc|write.in|\(wi\)', r['candidate'], re.I)]
            own = [r for r in named if matches(filer, r['candidate'])]
            if len(own) != 1:
                continue
            # A real opposing candidate, not the aggregate of miscellaneous votes.
            opposition = max((float(r['pct']) for r in named if r is not own[0]), default=0)
            cash = lambda y: sum(totals.get((fid, y), 0) for fid in ids)
            total, previous = cash(year), [cash(year - 4), cash(year - 2)]
            if not qualifies(total, previous, opposition):
                continue
            exclusions.append({'slug': filer['slug'], 'filer_ids': ids, 'name': filer['name'],
                'year': year, 'start': f'{year-1}-01-01', 'through': primary_date(year).isoformat(),
                'resume': (primary_date(year) + timedelta(days=1)).isoformat(),
                'primary_cash': round(total, 2), 'previous_primary_cash': [round(v, 2) for v in previous],
                'historical_median': round(statistics.median(previous), 2),
                'opposition_pct': opposition, 'office': office, 'district': district, 'party': party})
    return {'version': 1, 'rule': RULE,
            'source': 'ORESTAR cash contributions and Oregon legislative primary election_results',
            'latest_primary_year': max(int(r['year']) for r in elections),
            'exclusions': sorted(exclusions, key=lambda r: (r['year'], r['slug']))}


def main():
    import os
    import psycopg2
    import supabase_sync as sync
    sync._load_dotenv()
    with psycopg2.connect(**sync._parse_dsn(os.environ['SUPABASE_DB_URL']),
                          sslmode='require', connect_timeout=15) as conn:
        conn.set_session(readonly=True)
        with conn.cursor() as cur:
            cur.execute("set statement_timeout='60s'")
            cur.execute("select data from dashboard_cache where key='filer_index'")
            filers = cur.fetchone()[0]
            if isinstance(filers, str):
                filers = json.loads(filers)
            cur.execute("""select id,year,office_normalized,district,ballot_party,candidate,pct
                from election_results where election_type='Primary'
                and office_normalized in ('State Representative','State Senator') order by id""")
            columns = [c[0] for c in cur.description]
            elections = [dict(zip(columns, r)) for r in cur.fetchall()]
            if len(elections) < 1000 or len(filers) < 100:
                raise ValueError('Incomplete source data; keeping previous exclusion asset')
            ids = sorted({str(fid) for f in filers
                if f.get('office') in ('State Representative', 'State Senator')
                for fid in (f.get('filer_ids') or [f.get('filer_id')]) if fid})
            totals = {}
            for year in sorted({int(r['year']) for r in elections}):
                if primary_date(year) >= date.today():
                    continue
                cur.execute("""select filer_id,sum(amount) from transactions
                    where filer_id=any(%s) and tran_date between %s and %s
                    and tran_type='C' and coalesce(sub_type,'') not in
                    ('In-Kind Contribution','In-Kind/Forgiven Account Payable',
                     'In-Kind/Forgiven Personal Expenditures') group by filer_id""",
                    (ids, date(year-1, 1, 1), primary_date(year)))
                totals.update({(str(fid), year): float(amount) for fid, amount in cur.fetchall()})
    result = build(filers, elections, totals)
    # Validate everything before replacing the asset; no date-only churn.
    OUTPUT.write_text(json.dumps(result, indent=2) + '\n')
    print(f"Generated {len(result['exclusions'])} primary-campaign exclusions")


if __name__ == '__main__':
    main()
