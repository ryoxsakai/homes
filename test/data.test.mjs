import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../worker/auth.mjs';

const origin = 'https://homes.example.test';
const raw = 's'.repeat(43);
const cookie = '__Host-homes-session=' + raw;

function fixture() {
  let stores = 0, calls = [];
  let subject = {email:'allowed@example.test', sub:'google-owner'};
  let answer = {value:{tasks:[], categories:[], roles:[], revision:0}};
  const record = name => async (...args) => { calls.push([name, ...args]); return structuredClone(answer); };
  const env = {
    HOMES_AUTH_ORIGIN:origin, GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-secret',
    HOMES_OWNER_EMAIL:'allowed@example.test', HOMES_OWNER_SUB:'google-owner',
    HOME_STORE:{
      idFromName: name => name,
      get: key => {
        ++stores;
        assert.equal(key,'homes-data-v1:household');
        return {read:record('read'), putTodo:record('putTodo'), putMemo:record('putMemo'), cloneTodo:record('cloneTodo'), cloneResult:record('cloneResult')};
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
  return {call,write,env,storeCount:()=>stores,calls:()=>calls,setAnswer:a=>answer=a,setSubject:s=>subject=s};
}

test('data API authorizes before parsing, validates cookie and checks current allowlist', async () => {
  const f=fixture();
  const denied=await f.call('/api/todo',{method:'PUT',body:'bad JSON'},false);
  assert.equal(denied.status,401);
  assert.deepEqual(await denied.json(),{error:'unauthorized'});
  assert.equal((await f.call('/api/todo', {headers:{Cookie:cookie+'; '+cookie}})).status,401);
  assert.equal((await f.call('/api/memo', {headers:{Cookie:cookie.slice(0,-1)+'x'}})).status,401);
  f.env.HOMES_OWNER_SUB='not-the-current-user';
  assert.equal((await f.call('/api/me')).status,401);
  f.env.HOMES_OWNER_SUB='google-owner';
  f.setSubject(null);
  assert.equal((await f.call('/api/todo')).status,401);
  assert.equal(f.storeCount(),0);
});

test('documents are private JSON on the canonical host, with the Works planner flag', async () => {
  const f=fixture();
  f.setAnswer({value:{tasks:[{name:'PRIVATE FIXTURE'}], revision:3}});
  const result=await f.call('/api/todo');
  assert.equal(result.status,200);
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal(result.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
  assert.match(result.headers.get('Content-Type'),/^application\/json/);
  assert.deepEqual(await result.json(),{tasks:[{name:'PRIVATE FIXTURE'}], revision:3, plannerVersion:1});
  assert.deepEqual(f.calls().at(-1),['read','todo']);
  assert.equal((await (await f.call('/api/memo')).json()).plannerVersion,undefined);
  assert.deepEqual(f.calls().at(-1),['read','memo']);
  assert.deepEqual(await (await f.call('/api/me')).json(),{name:'管理者'});
  for (const headers of [{Origin:'https://other.example.test'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}]) {
    const denied = await f.call('/api/todo',{headers});
    assert.equal(denied.status,403);
    assert.deepEqual(await denied.json(),{error:'forbidden'});
  }
  const root=await f.call('/',{},false);
  assert.doesNotMatch(await root.text(),/PRIVATE FIXTURE/);
  assert.equal((await f.call('https://wrong.example.test/api/todo')).status,404);
  delete f.env.HOME_STORE;
  assert.equal((await f.call('/api/todo')).status,503);
});

test('strict mutation Origin, media type, request size and strict routes', async () => {
  const f=fixture();
  assert.equal((await f.write('/api/todo','PUT',{revision:0},{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.write('/api/todo','PUT',{revision:0},{Origin:'null'})).status,403);
  assert.equal((await f.call('/api/todo',{method:'PUT',body:'{}'})).status,403);
  assert.equal((await f.write('/api/memo','PUT',{revision:0},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.write('/api/memo','PUT',{revision:0},{'Content-Length':'2000000'})).status,413);
  const chunks=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1_600_000)); controller.close();}});
  assert.equal((await f.call('/api/todo',{method:'PUT',body:chunks,headers:{Origin:origin,'Content-Type':'application/json'}})).status,413);
  assert.equal((await f.call('/api/todo',{method:'PUT',body:'{',headers:{Origin:origin,'Content-Type':'application/json'}})).status,400);
  assert.equal((await f.call('/api/todo',{method:'DELETE',headers:{Origin:origin}})).status,405);
  assert.equal((await f.call('/api/me',{method:'POST',headers:{Origin:origin}})).status,405);
  assert.equal((await f.call('/api/todos')).status,404);
  assert.equal((await f.call('/api/home')).status,404);
  assert.equal((await f.call('/api/todo?spoof=value')).status,400);
  assert.equal((await f.call('/api/todo/clone?request_id=short')).status,400);
  assert.equal((await f.call('/api/todo/clone?request_id=abcdefghijklmnop&x=1')).status,400);
  assert.deepEqual(f.calls(),[]);
  assert.equal((await f.call('/api/todo/clone?request_id=abcdefghijklmnop')).status,200);
  assert.deepEqual(f.calls().at(-1),['cloneResult','abcdefghijklmnop']);
});

test('writes pass the server-side family alias, never a browser-supplied actor', async () => {
  const f=fixture();
  f.env.HOMES_FAMILY_MEMBERS = JSON.stringify([{email:'alice@gmail.com', alias:'家族A'}]);
  f.setSubject({email:'alice@gmail.com', sub:'subject-a'});
  assert.equal((await f.write('/api/todo','PUT',{revision:0,tasks:[],categories:[],actor:'spoof'})).status,200);
  assert.deepEqual(f.calls().at(-1),['putTodo',{revision:0,tasks:[],categories:[],actor:'spoof'},'家族A']);
  assert.equal((await f.write('/api/todo/clone','POST',{request_id:'abcdefghijklmnop'})).status,200);
  assert.equal(f.calls().at(-1)[2],'家族A');
  assert.equal((await f.write('/api/memo','PUT',{revision:0})).status,200);
  assert.deepEqual(f.calls().at(-1),['putMemo',{revision:0}]);
  f.setAnswer({error:{status:409,message:'変更が競合しました'}});
  const conflict=await f.write('/api/todo','PUT',{revision:0});
  assert.equal(conflict.status,409);
  assert.deepEqual(await conflict.json(),{error:'変更が競合しました'});
  f.setAnswer({error:{status:500,message:'internal'}});
  assert.equal((await f.write('/api/memo','PUT',{revision:0})).status,400);
});

test('family mode revokes removed members with valid sessions', async () => {
  const f = fixture();
  const members = [{email:'alice@gmail.com', alias:'家族A'}, {email:'bob@example.test', sub:'subject-b', alias:'家族B'}];
  f.env.HOMES_FAMILY_MEMBERS = JSON.stringify(members);
  assert.equal((await f.call('/api/me')).status, 401); // Legacy owner omitted from family mode.
  f.setSubject({email:'bob@example.test', sub:'other-b'});
  assert.equal((await f.call('/api/me')).status, 401);
  f.setSubject({email:'bob@example.test', sub:'subject-b'});
  assert.deepEqual(await (await f.call('/api/me')).json(), {name:'家族B'});
  f.env.HOMES_FAMILY_MEMBERS = JSON.stringify(members.slice(0, 1));
  assert.equal((await f.call('/api/me')).status, 401);
  for (const raw of ['', '{}', '[]', JSON.stringify([...members,{email:'x@gmail.com',alias:'家族A'}]),
    JSON.stringify([{email:'x@example.test',alias:'家族C'}])]) {
    f.env.HOMES_FAMILY_MEMBERS = raw;
    assert.equal((await f.call('/api/me')).status, 503);
  }
});
