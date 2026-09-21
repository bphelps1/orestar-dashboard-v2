"""Database regression for the immediate merge migration.

Opt in with ORESTAR_TEST_DB=1. Uses a private, uncommitted schema and always
rolls it back; never applies the migration to public or changes source data.
"""
import os
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scraper'))

@pytest.mark.skipif(os.environ.get('ORESTAR_TEST_DB') != '1', reason='requires opt-in database connection')
def test_immediate_merges_across_reads_and_undo():
    import supabase_sync as s
    import psycopg2
    try:
        conn = psycopg2.connect(**s._parse_dsn(os.environ['ORESTAR_TEST_DSN']), sslmode='require')
    except Exception:
        raise RuntimeError('Could not connect to the explicitly configured test database') from None
    schema = 'test_merge_' + uuid.uuid4().hex
    try:
        q = conn.cursor()
        q.execute(f'create schema {schema}')
        q.execute(f'set local search_path={schema}')
        for table in ['donors','donor_aliases','donor_merge_overrides','donor_lobbyist_links',
                      'donor_client_links','donor_contacts','transactions','filer_detail','lobbyists','lobbyist_clients']:
            q.execute(f'create table {schema}.{table} (like public.{table} including all)')
        normalize = (ROOT/'supabase/migrations/014_donor_leaderboard.sql').read_text().split('create or replace view')[0]
        migration = (ROOT/'supabase/migrations/021_immediate_entity_merges.sql').read_text()
        # All tables/functions/views/policies and grants stay in this schema.
        sql = (normalize + migration).replace('public.', schema + '.').replace('search_path = public', 'search_path = '+schema).replace('search_path=public', 'search_path='+schema)
        q.execute(sql)
        q.execute("insert into donors(donor_id,display_name,total_given,gift_count) values ('a','Acme',100,1),('b','Acme Services',200,1),('c','Acme LLC',300,1),('x','Unrelated',400,1)")
        q.execute("insert into donor_aliases(alias_key,donor_id,raw_name,norm_name,addr_key,source) values ('aa','a','Acme','acme','','test'),('bb','b','Acme Services','acme services','','test'),('bb2','b','Acme Services Other','acme services other','','test'),('cc','c','Acme LLC','acme llc','','test'),('xx','x','Unrelated','unrelated','','test')")
        q.execute("insert into transactions(tran_id,donor_id,tran_type,tran_date,filer_id,filer,amount,contributor_payee) values (1,'a','C','2026-02-01','f','Candidate',100,'Acme'),(2,'b','C','2026-01-01','f','Candidate',200,'Acme Services'),(3,'c','C','2026-03-01','f','Candidate',300,'Acme LLC'),(4,'x','C','2026-01-01','f','Candidate',400,'Unrelated')")
        q.execute("insert into filer_detail(slug,name,filer_id,detail) values ('candidate','Candidate','f','{}')")
        # B connects through two DIFFERENT alias keys; transitivity is by ID.
        q.execute("insert into donor_merge_overrides(merge_key,alias_a,alias_b,decision,keep_alias_key) values ('ab','aa','bb','merged','aa'),('bc','bb2','cc','merged',null)")
        q.execute("select donor_identity('b')")
        identity = q.fetchone()[0]
        assert identity['donor_id'] == 'a' and identity['total_given'] == 600
        assert set(identity['member_ids']) == {'a','b','c'}
        q.execute("select * from search_donors('Acme',12)")
        search=q.fetchall(); assert len(search)==1 and search[0][0]=='a' and search[0][5]==600
        q.execute("select * from donor_search('Services',50)")
        assert q.fetchone()[0]=='a'
        q.execute("select donor_profile('c')")
        profile=q.fetchone()[0]; assert profile['top_recipients'][0]['total']==600
        assert profile['top_recipients'][0]['n']==3
        q.execute("select donor_leaderboard(null,null,array['f'])")
        rows=q.fetchone()[0]['all_time']; assert len(rows)==2
        assert rows[0]['donor_id']=='a' and rows[0]['total']==600
        q.execute("select sum(amount) from donor_contribution_rows where donor_id='a'")
        assert q.fetchone()[0]==600
        q.execute("select * from recommendation_first_gifts(array['a'],array['f'],date '2026-12-31')")
        first=q.fetchone(); assert first[0]=='a' and first[3]==200
        q.execute("select * from donor_merge_filers")
        assert q.fetchall()==[('f',)]
        # No rewrite or full resolver was necessary; raw IDs are untouched.
        q.execute('select donor_id from transactions order by tran_id')
        assert q.fetchall()==[('a',),('b',),('c',),('x',)]
        # Conflicting explicit separate decisions cannot be overridden by a
        # transitive new merge. The whole statement is rejected.
        q.execute("insert into donor_merge_overrides(merge_key,alias_a,alias_b,decision) values ('cx','cc','xx','separate')")
        q.execute('savepoint conflict_test')
        try:
            q.execute("insert into donor_merge_overrides(merge_key,alias_a,alias_b,decision) values ('ax','aa','xx','merged')")
        except Exception as error:
            assert 'conflicts with an existing separate decision' in str(error)
            q.execute('rollback to savepoint conflict_test')
        else:
            raise AssertionError('conflicting merge was accepted')
        # Reviewed attributions survive on the group; any explicit rejection
        # remains a veto, even when it was filed under a different member.
        q.execute("insert into lobbyists(lobbyist_id,name) overriding system value values (1,'Lobbyist')")
        q.execute("insert into donor_lobbyist_links(donor_id,lobbyist_id,method,status) values ('b',1,'manual','confirmed')")
        q.execute("select donor_id from donor_lobbyists")
        assert q.fetchall()==[('a',)]
        q.execute("insert into donor_lobbyist_links(donor_id,lobbyist_id,method,status) values ('c',1,'manual','rejected')")
        q.execute("select donor_id from donor_lobbyists")
        assert q.fetchall()==[]
        # Undo changes the read-through immediately, with no lossy data split.
        q.execute("delete from donor_merge_overrides where merge_key='ab'")
        q.execute("select donor_identity('a')")
        assert q.fetchone()[0]['total_given']==100
        q.execute("select donor_identity('c')")
        assert q.fetchone()[0]['total_given']==500
        # Historical IDs route to the current cluster after physical resolution.
        q.execute("insert into donors(donor_id,display_name,total_given,gift_count) values ('new','Combined',500,2)")
        q.execute("update donor_aliases set donor_id='new' where donor_id in ('b','c')")
        q.execute("delete from donors where donor_id in ('b','c')")
        q.execute("select donor_group_ids('b')")
        assert set(q.fetchone()[0])=={'new','b','c'}
        # A full re-resolution must replace stale non-null IDs. Source rows
        # with an authoritative ORESTAR committee ID remain protected.
        import resolve_donors
        q.execute("create table _dmap(raw_name text,addr text,zip text,donor_id text)")
        q.execute("insert into _dmap values ('Acme Services','','','new'),('Acme LLC','','','new'),('Unrelated','','','bad')")
        q.execute("update transactions set contributor_payee_committee_id='123' where tran_id=4")
        assert resolve_donors.stamp_resolved_batch(q,0,10)==2
        q.execute('select donor_id from transactions order by tran_id')
        assert q.fetchall()==[('a',),('new',),('new',),('x',)]
        # Read functions are usable by the actual web role, with no write grant.
        q.execute(f'grant usage on schema {schema} to anon')
        q.execute(f'grant select on all tables in schema {schema} to anon')
        q.execute('set local role anon')
        q.execute(f"select {schema}.donor_identity('b')")
        assert q.fetchone()[0]['donor_id']=='new'
    finally:
        conn.rollback()
        conn.close()
