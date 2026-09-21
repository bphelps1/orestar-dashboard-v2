"""Opt-in, rollback-only migration test. No production records are modified."""
import os
import sys
import uuid
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scraper"))

@pytest.mark.skipif(os.environ.get('ORESTAR_TEST_DB') != '1', reason='requires opt-in database')
def test_client_removal_survives_imports_and_can_be_restored():
    import psycopg2
    import supabase_sync as s
    conn=psycopg2.connect(**s._parse_dsn(os.environ['ORESTAR_TEST_DSN']),sslmode='require')
    schema='test_clients_'+uuid.uuid4().hex
    try:
        q=conn.cursor()
        q.execute(f'create schema {schema}; set local search_path={schema}')
        for table in ['lobbyists','lobbyist_clients']:
            q.execute(f'create table {schema}.{table} (like public.{table} including all)')
        q.execute('create table user_roles(user_id uuid,role text)')
        user=str(uuid.uuid4())
        q.execute("insert into user_roles values (%s,'reviewer')",(user,))
        q.execute("select set_config('request.jwt.claim.sub',%s,true)",(user,))
        sql=(Path(__file__).resolve().parents[1]/'supabase/migrations/023_lobbyist_client_editor.sql').read_text()
        q.execute(sql.replace('public.',schema+'.').replace('search_path=public','search_path='+schema))
        q.execute("insert into lobbyists(lobbyist_id,name) overriding system value values(1,'One'),(2,'Two')")
        q.execute("insert into lobbyist_clients(lobbyist_id,client_key,client_name,source,active,is_lead) values(1,'acme','Acme','capitol_club',true,true),(1,'acme','Acme','manual',true,true),(2,'acme','Acme','capitol_club',true,true)")
        q.execute(f'grant usage on schema {schema} to authenticated; grant select,insert,update,delete on all tables in schema {schema} to authenticated')
        q.execute('set local role authenticated')
        q.execute("select * from edit_lobbyist_client(1,'acme',false)")
        q.execute('select bool_or(active),bool_or(is_lead) from lobbyist_clients where lobbyist_id=1')
        assert q.fetchone()==(False,False)
        q.execute('reset role')
        # Imported reactivation, including a brand-new source, cannot undo removal.
        q.execute('update lobbyist_clients set active=true,is_lead=true where lobbyist_id=1')
        q.execute("insert into lobbyist_clients(lobbyist_id,client_key,client_name,source,active) values(1,'acme','Acme','new_import',true)")
        q.execute('select bool_or(active),bool_or(is_lead) from lobbyist_clients where lobbyist_id=1')
        assert q.fetchone()==(False,False)
        q.execute('select active,is_lead from lobbyist_clients where lobbyist_id=2')
        assert q.fetchone()==(True,True)
        q.execute('set local role authenticated')
        q.execute("select * from edit_lobbyist_client(1,'acme',true)")
        q.execute("select active,is_lead from lobbyist_clients where lobbyist_id=1 and source='manual'")
        assert q.fetchone()==(True,False)
        q.execute("select set_config('request.jwt.claim.sub',%s,true)",(str(uuid.uuid4()),))
        q.execute('savepoint unauthorized')
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            q.execute("select * from edit_lobbyist_client(1,'acme',false)")
        q.execute('rollback to savepoint unauthorized')
    finally:
        conn.rollback()
        conn.close()
