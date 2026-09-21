import importlib.util
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location('primary_campaigns', Path(__file__).parents[1] / 'scraper/refresh_primary_campaigns.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def test_rule_requires_both_opposition_and_material_cash_surge():
    assert m.qualifies(45636, [24475, 28650], 23.8)
    assert m.qualifies(465156.8, [74887.88, 60362], 51.95)
    assert m.qualifies(262989, [129370, 36750], 27.16)
    assert not m.qualifies(45636, [24475, 28650], 19.99)
    assert not m.qualifies(30000, [24475, 28650], 40)
    assert not m.qualifies(24999, [1000, 2000], 40)
    assert not m.qualifies(26000, [17000, 17000], 40)
    assert not m.qualifies(50000, [0, 10000], 40)
    assert not m.qualifies(50000, [10000], 40)


def test_primary_dates_and_middle_name_matching():
    assert m.primary_date(2026) == date(2026, 5, 19)
    assert m.primary_date(2024) == date(2024, 5, 21)
    assert m.matches({'candidate_name': 'Daniel Nguyễn'}, 'Nguyen Daniel Loc')
    assert not m.matches({'candidate_name': 'Daniel Nguyen'}, 'Nguyen Jane')


FILER = {'slug': 'jane', 'name': 'Friends of Jane Example', 'candidate_name': 'Jane Example',
         'office': 'State Representative', 'party': 'Democrat', 'filer_id': '1', 'filer_ids': ['1', '2']}

def race(names):
    return [dict(id=i, year=2026, office_normalized='State Representative', district='1st District',
                 ballot_party='Democrat', candidate=name, pct=pct)
            for i, (name, pct) in enumerate(names)]


def test_combines_committee_ids_and_excludes_full_primary_window():
    totals = {('1', 2022): 10000, ('1', 2024): 10000, ('1', 2026): 20000, ('2', 2026): 10000}
    result = m.build([FILER], race([('Example Jane', 75), ('Opponent Other', 25)]), totals, date(2026, 6, 1))
    flag = result['exclusions'][0]
    assert flag['primary_cash'] == 30000
    assert (flag['start'], flag['through'], flag['resume']) == ('2025-01-01', '2026-05-19', '2026-05-20')
    assert not m.build([FILER], race([('Example Jane', 75), ('Opponent Other', 25)]), totals, date(2026, 5, 19))['exclusions']


def test_cross_party_headers_and_writeins_do_not_create_opposition():
    totals = {('1', 2022): 10000, ('1', 2024): 10000, ('1', 2026): 30000}
    rows = race([('Example Jane', 99), ('Misc.', 1), ('Republican *Other Person', 85), ('Someone Else', 15)])
    assert not m.build([FILER], rows, totals)['exclusions']
    rows = race([('Example Jane', 70), ('Other Person (WI)', 30)])
    assert not m.build([FILER], rows, totals)['exclusions']
    rows = race([('Example Jane', 99), ('Other Person', 95)])
    assert not m.build([FILER], rows, totals)['exclusions']
