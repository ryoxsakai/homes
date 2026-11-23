import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../worker/auth.mjs';
import {validateFields} from '../worker/data.mjs';

const origin = 'https://homes.example.test';
const household = '00000000-1111-4222-8333-444444444444';
const id = '11111111-1111-4111-8111-111111111111';
const raw = 's'.repeat(43);
const cookie = '__Host-homes-session=' + raw;

function fixture() {
  let stores = 0;
  let subject = {email:'allowed@example.test', sub:'google-owner'};
  let mutation, mutResult = {record:{id,title:'ToDo',version:1}};
  const env = {
    HOMES_AUTH_ORIGIN:origin, GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-secret',
    HOMES_OWNER_EMAIL:'allowed@example.test', HOMES_OWNER_SUB:'google-owner', HOMES_HOUSEHOLD_ID:household,
    HOME_STORE:{
      idFromName: name => name,
      get: key => {
        ++stores;
        assert.equal(key,'homes-data-v1:'+household);
        return {list: async () => ({todos:[],notes:[{title:'PRIVATE FIXTURE'}]}), mutate: async (...args) => {mutation = args; return mutResult;}};
      }
    }
  };
  // Compute the expected hash independently, without exposing a server-side auth shortcut.
  const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))));
  env.AUTH_STORE = {idFromName: name => name, get: () => ({ readSession: async key => {
    const expected = btoa(String.fromCharCode(...await hash())).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    return key === expected ? subject : null;
  }})};
  const app = createApp();
  const call = (url, init = {}, auth = true) => app.fetch(new Request(new URL(url,origin), init.body instanceof ReadableStream
    ? {...init,duplex:'half',headers:{...(auth ? {Cookie:cookie} : {}),...init.headers}}
    : {...init,headers:{...(auth ? {Cookie:cookie} : {}),...init.headers}}),env);
  const write = (url, method, input, headers = {}) => call(url,{method,body:JSON.stringify(input),headers:{Origin:origin,'Content-Type':'application/json',...headers}});
  return {call,write,env,storeCount:()=>stores,mutation:()=>mutation,setResult:r=>mutResult=r, setSubject:s=>subject=s};
}

test('data API authorizes before parsing, validates cookie and checks current allowlist', async () => {
  const f=fixture();
  const denied=await f.call('/api/todos',{method:'POST',body:'bad JSON'},false);
  assert.equal(denied.status,401);
  assert.deepEqual(await denied.json(),{error:'unauthorized'});
  assert.equal((await f.call('/api/home', {headers:{Cookie:cookie+'; '+cookie}})).status,401);
  assert.equal((await f.call('/api/home', {headers:{Cookie:cookie.slice(0,-1)+'x'}})).status,401);
  f.env.HOMES_OWNER_SUB='not-the-current-user';
  assert.equal((await f.call('/api/home')).status,401);
  f.env.HOMES_OWNER_SUB='google-owner';
  f.setSubject(null);
  assert.equal((await f.call('/api/home')).status,401);
  assert.equal(f.storeCount(),0);
});

test('data API returns private JSON only on canonical protected host, never public page', async () => {
  const f=fixture();
  const result=await f.call('/api/home');
  assert.equal(result.status,200);
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal(result.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
  for (const headers of [{Origin:'https://other.example.test'},
    {'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}]) {
    const denied = await f.call('/api/home',{headers});
    assert.equal(denied.status,403);
    assert.deepEqual(await denied.json(),{error:'forbidden'});
  }
  assert.match(result.headers.get('Content-Type'),/^application\/json/);
  assert.equal((await result.json()).notes[0].title,'PRIVATE FIXTURE');
  const root=await f.call('/',{},false);
  assert.doesNotMatch(await root.text(),/PRIVATE FIXTURE/);
  assert.equal((await f.call('https://wrong.example.test/api/home')).status,404);
  delete f.env.HOMES_HOUSEHOLD_ID;
  assert.equal((await f.call('/api/home')).status,503);
  f.env.HOMES_HOUSEHOLD_ID='not-an-id';
  assert.equal((await f.call('/api/home')).status,503);
});

test('strict mutation Origin, media type, request size and strict routes', async () => {
  const f=fixture();
  assert.equal((await f.write('/api/todos','POST',{title:'test'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.write('/api/todos','POST',{title:'test'},{Origin:'null'})).status,403);
  assert.equal((await f.call('/api/todos',{method:'POST',body:'{}'})).status,403);
  assert.equal((await f.write('/api/todos','POST',{title:'test'},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.write('/api/todos','POST',{title:'test'},{'Content-Length':'90000'})).status,413);
  const chunks=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(81_000)); controller.close();}});
  assert.equal((await f.call('/api/todos',{method:'POST',body:chunks,headers:{Origin:origin,'Content-Type':'application/json'}})).status,413);
  assert.equal((await f.call('/api/todos',{method:'POST',body:'{',headers:{Origin:origin,'Content-Type':'application/json'}})).status,400);
  assert.equal((await f.call('/api/todos')).status,405);
  assert.equal((await f.call('/api/todos/invalid-id')).status,404);
  assert.equal((await f.call('/api/home?spoof=value')).status,400);
  assert.equal(f.mutation(),undefined);
});

test('create, edit, delete version contract and conflict, quota and missing responses', async () => {
  const f=fixture();
  const post=await f.write('/api/todos','POST',{title:' 買い物 ',dueDate:'2028-02-29'});
  assert.equal(post.status,201);
  assert.deepEqual(f.mutation(),['todos','POST',null,{title:'買い物',dueDate:'2028-02-29'},'管理者']);
  const patch=await f.write('/api/todos/'+id,'PATCH',{version:1,completed:true,dueDate:null});
  assert.equal(patch.status,200);
  assert.deepEqual(f.mutation(),['todos','PATCH',id,{version:1,completed:true,dueDate:null},'管理者']);
  f.setResult({error:'version_conflict'});
  assert.deepEqual(await (await f.write('/api/todos/'+id,'PATCH',{version:1,completed:false})).json(),{error:'version_conflict'});
  assert.equal((await f.write('/api/todos/'+id,'DELETE',{version:1})).status,409);
  f.setResult({error:'quota_exceeded'});
  assert.equal((await f.write('/api/notes','POST',{title:'読書',body:''})).status,409);
  f.setResult({error:'not_found'});
  assert.equal((await f.write('/api/notes/'+id,'DELETE',{version:2})).status,404);
  f.setResult({});
  const deleted=await f.write('/api/notes/'+id,'DELETE',{version:2});
  assert.equal(deleted.status,204);
  assert.equal(await deleted.text(),'');
});

test('validates date-only roundtrip, title/body size and exact shape', () => {
  const cases=[
    ['todos','POST',{title:'',dueDate:null}],['todos','POST',{title:'x'.repeat(121)}],
    ['todos','POST',{title:'x',dueDate:'2026-02-29'}],['todos','POST',{title:'x',dueDate:'0000-01-01'}],
    ['todos','POST',{title:'x',dueDate:'2028-02-29T00:00:00Z'}],['todos','POST',{title:'x',completed:false}],
    ['todos','PATCH',{version:1,completed:1}],['todos','PATCH',{version:1}],['todos','DELETE',{version:0}],
    ['notes','POST',{title:'x'}],['notes','POST',{title:'x',body:'x'.repeat(12_001)}],
    ['notes','PATCH',{version:1,title:'x',owner:'fake'}],['notes','DELETE',{version:1,body:'x'}],
  ];
  for (const args of cases) assert.equal(validateFields(...args),null);
  assert.deepEqual(validateFields('notes','PATCH',{version:2,body:'<img>\ntext'}),{version:2,body:'<img>\ntext'});
});

test('family mode uses server-only aliases and revokes removed members with valid sessions', async () => {
  const f = fixture();
  const members = [
    {email:'alice@gmail.com', alias:'家族A'},
    {email:'bob@example.test', sub:'subject-b', alias:'家族B'}
  ];
  f.env.HOMES_FAMILY_MEMBERS = JSON.stringify(members);
  assert.equal((await f.call('/api/home')).status, 401); // Legacy owner omitted from family mode.
  f.setSubject({email:'alice@gmail.com', sub:'subject-a'});
  assert.equal((await f.write('/api/todos','POST',{title:'共有'})).status, 201);
  assert.equal(f.mutation().at(-1), '家族A');
  for (const key of ['createdBy','updatedBy','completedBy','actor']) {
    assert.equal((await f.write('/api/todos/'+id,'PATCH',{version:1,completed:true,[key]:'spoof'})).status, 400);
  }
  f.setSubject({email:'bob@example.test', sub:'other-b'});
  assert.equal((await f.call('/api/home')).status, 401);
  f.setSubject({email:'bob@example.test', sub:'subject-b'});
  assert.equal((await f.write('/api/todos/'+id,'PATCH',{version:1,completed:true})).status, 200);
  assert.equal(f.mutation().at(-1), '家族B');
  f.env.HOMES_FAMILY_MEMBERS = JSON.stringify(members.slice(0, 1));
  assert.equal((await f.call('/api/home')).status, 401);
  for (const raw of ['', '{}', '[]', JSON.stringify([...members,{email:'x@gmail.com',alias:'家族A'}]),
    JSON.stringify([{email:'x@example.test',alias:'家族C'}])]) {
    f.env.HOMES_FAMILY_MEMBERS = raw;
    assert.equal((await f.call('/api/home')).status, 503);
  }
});
