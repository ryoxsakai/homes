import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApp} from '../worker/auth.mjs';

const legacy='https://homes.example.test', custom='https://homes.lrnr.jp';
test('both hosts keep OAuth callbacks, attempts and sessions separate without migrating legacy keys', async()=>{
 const attempts=new Map(), sessions=new Map(), exchanges=[];
 const store={
   async putState(k,nonce,verifier){attempts.set(k,{nonce,verifier});},
   async takeState(k){const v=attempts.get(k);attempts.delete(k);return v;},
   async readSession(k){return sessions.get(k);},
   async removeSession(k){sessions.delete(k);},
   async replaceSession(k,email,sub,old){sessions.delete(old);sessions.set(k,{email,sub});}
 };
 const env={HOMES_AUTH_ORIGIN:legacy,GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',
   HOMES_OWNER_EMAIL:'test@gmail.com',HOME_STORE:{idFromName(n){assert.equal(n,'homes-data-v1:household');return n},get(){return {read:async kind=>({value:{kind}})}}},AUTH_STORE:{idFromName(n){assert.equal(n,'homes-auth-v1');return n},get(){return store}}};
 const opts={installIcon:new Uint8Array([1]), assets:{fetch:async()=>new Response('app',{headers:{'Content-Type':'text/html'}})}, verify:async()=>({email:'test@gmail.com',sub:'test'}),
   upstream:async(_,init)=>{exchanges.push(init.body.get('redirect_uri'));return Response.json({id_token:'token'});}};
 const app=createApp(opts);
 const req=(host,path,cookie,method='GET',origin,server=app)=>server.fetch(new Request(host+path,{method,headers:{
   ...(cookie&&{Cookie:cookie}),...(origin&&{Origin:origin})
 }}),env);
 const ck=(reply,name)=>reply.headers.getSetCookie().find(s=>s.startsWith(name+'='))?.split(';')[0];
 const begin=async (host,server)=>{
   const r=await req(host,'/auth/start',null,'GET',null,server);
   assert.equal(r.status,303);
   const q=new URL(r.headers.get('location')).searchParams;
   assert.equal(q.get('redirect_uri'),host+'/auth/callback');
   assert.equal(q.get('scope'),'openid email profile');
   assert.match(r.headers.get('set-cookie'),/; Secure; HttpOnly; SameSite=Lax/);
   assert.doesNotMatch(r.headers.get('set-cookie'),/Domain=/i);
   return {path:'/auth/callback?code=test&state='+q.get('state'), cookie:ck(r,'__Host-homes-state')};
 };
 const finish=async(host,attempt,status=303)=>{
   const r=await req(host,attempt.path,attempt.cookie);
   assert.equal(r.status,status);
   if(status!==303)return;
   assert.equal(r.headers.get('location'),'/');
   assert.equal(exchanges.at(-1),host+'/auth/callback');
   return ck(r,'__Host-homes-session');
 };
 // Seed a predeploy attempt and existing session with their exact legacy SHA-256
 // storage format, independent of the candidate's /auth/start implementation.
 const legacyKey = value => createHash('sha256').update(value).digest('base64url');
 const predeployState='s'.repeat(43), predeploySession='q'.repeat(43);
 attempts.set(legacyKey(predeployState),{nonce:'test',verifier:'test'});
 sessions.set(legacyKey(predeploySession),{email:'test@gmail.com',sub:'test'});
 assert.equal((await req(legacy,'/app','__Host-homes-session='+predeploySession)).status,200);
 assert.equal((await req(custom,'/app','__Host-homes-session='+predeploySession)).status,303);
 const oldAttempt={path:'/auth/callback?code=test&state='+predeployState,cookie:'__Host-homes-state='+predeployState};
 const legacyAttempt=await begin(legacy);
 const newAttempt=await begin(custom);
 await finish(custom,oldAttempt,400);
 await finish(legacy,newAttempt,400);
 assert.equal(exchanges.length,0);
 const oldCookie=await finish(legacy,oldAttempt);
 await finish(legacy,legacyAttempt);
 const newCookie=await finish(custom,newAttempt);
 for(const [host,own,other] of [[legacy,oldCookie,newCookie],[custom,newCookie,oldCookie]]){
   assert.equal((await req(host,'/')).status,200);
   assert.equal((await req(host,'/homes.webmanifest')).status,200);
   assert.equal((await req(host,'/homes-icon.png')).status,200);
   assert.equal((await req(host,'/app',own)).status,200);
   assert.equal((await req(host,'/app',other)).headers.get('location'),'/');
   assert.equal((await req(host,'/api/memo',own,'GET',host===legacy?custom:legacy)).status,403);
   assert.deepEqual(await (await req(host,'/api/memo',own)).json(),{kind:'memo'});
   assert.equal((await req(host,'/auth/logout',own,'POST',host===legacy?custom:legacy)).status,403);
 }
 assert.equal((await req(custom,'/auth/logout',newCookie,'POST',custom)).status,303);
 assert.equal((await req(legacy,'/app',oldCookie)).status,200);
 for(const host of ['http://homes.lrnr.jp','https://www.homes.lrnr.jp','https://homes.lrnr.jp.evil.test','https://homes.lrnr.jp:444']){
   for(const path of ['/auth/start','/auth/callback','/homes.webmanifest','/api/todo','/app','/todo/']){
     assert.equal((await req(host,path)).status,404);
   }
 }
});
