const icons={home:'<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',plus:'<path d="M12 5v14M5 12h14"/>',settings:'<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="var(--surface)"/><circle cx="16" cy="12" r="2" fill="var(--surface)"/><circle cx="10" cy="17" r="2" fill="var(--surface)"/>',todo:'<path d="m3 6 1.5 1.5L7 5m3 1h11M3 12l1.5 1.5L7 11m3 1h11M3 18l1.5 1.5L7 17m3 1h11"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4m-8 8h2m4 0h2"/>',notes:'<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8m-8 4h6"/>',inbox:'<path d="M4 4h16l2 11v5H2v-5zM2 15h6l2 2h4l2-2h6"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',arrow:'<path d="m9 6 6 6-6 6"/>'};
icons.search='<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>';
icons.edit='<path d="m14 5 5 5M4 20l4.5-1L21 6.5 17.5 3 5 15.5z"/>';
const svg=k=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[k]+'</svg>';
const $=s=>document.querySelector(s);
const preferenceKeys=new Set(['theme','service','todo-tab']);
function pref(k,v){if(!preferenceKeys.has(k))return null;try {if(v===undefined)return localStorage.getItem('homes.display.'+k);localStorage.setItem('homes.display.'+k,v);}catch{}return null;}
const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const services={todo:['ToDo','TASKS'],notes:['メモ','NOTES']};
const views={upcoming:['近日予定','calendar'],inbox:['インボックス','inbox'],done:['完了済み','check']};
function asService(k){return Object.hasOwn(services,k)?k:null;}
function asView(k){return Object.hasOwn(views,k)?k:null;}
let service=asService(location.hash.slice(1))||asService(pref('service'))||'todo';
let view=asView(pref('todo-tab'))||'upcoming';
let theme=pref('theme')==='dark'?'dark':'light';
let items={todos:[],notes:[]}, ready=false, loading=false, pending=false, unauth=false, active=null, toastTimer, search='';
const localDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
const localTime=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'short'});
const day=()=>{const parts=Object.fromEntries(localDay.formatToParts(Date.now()).map(x=>[x.type,x.value]));return parts.year+'-'+parts.month+'-'+parts.day;};
const dateLabel=x=>x?x.split('-').map(Number).slice(1).join('/'):'';
const normalize=s=>String(s??'').normalize('NFKC').toLocaleLowerCase('ja');
function fmtTime(x){const date=new Date(x);return Number.isFinite(date.getTime())?localTime.format(date):'';}
function collection(k){return k==='todo'?'todos':'notes';}
function find(k,id){return items[collection(k)].find(x=>String(x.id)===String(id));}
function setTheme(v){theme=v;document.documentElement.dataset.theme=v;pref('theme',v);$('#toggle-theme').textContent=v==='dark'?'ライトに切替':'ダークに切替';}
setTheme(theme);
for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=svg(el.dataset.icon);
function renderNav(){
  $('#services').innerHTML=Object.entries(services).map(([k,[title]])=>'<a href="#'+k+'" data-service-link="'+k+'"'+(k===service?' aria-current="page"':'')+'><span class="app-icon" data-service="'+k+'">'+svg(k)+'</span>'+title+'</a>').join('');
  $('#eyebrow').textContent=services[service][1];$('#page-title').textContent=services[service][0];
  $('#tabs').hidden=$('#screenbar').hidden=service!=='todo';$('#note-tools').hidden=service!=='notes';
  $('#tabs').innerHTML=Object.entries(views).map(([k,[name]])=>'<button type="button" role="tab" id="tab-'+k+'" aria-controls="primary-content" aria-selected="'+(k===view)+'" tabindex="'+(k===view?'0':'-1')+'" data-view="'+k+'">'+name+'</button>').join('');
  $('#screenbar').innerHTML=Object.entries(views).map(([k,[name,icon]])=>'<button type="button" aria-label="'+name+'" aria-pressed="'+(k===view)+'" data-view="'+k+'">'+svg(icon)+'</button>').join('');
}
function panel(title,sub,body,button=''){
  return '<article class="card list-card"><div class="card-head"><div><h2>'+html(title)+'</h2>'+(sub?'<p>'+html(sub)+'</p>':'')+'</div>'+button+'</div>'+body+'</article>';
}
function action(k){const name=services[k][0];return '<button type="button" class="icon-btn" data-create="'+k+'" aria-label="'+name+'を追加" title="'+name+'を追加">'+svg('plus')+'</button>';}
function actorName(value){
 return typeof value==='string'?value.trim():'';
}
function todoActorCaption(x){
 const completion=actorName(x.completedBy),updated=actorName(x.updatedBy),created=actorName(x.createdBy);
 if(x.completed&&completion)return '完了：'+completion;
 if(updated&&(!created||x.updatedAt!==x.createdAt||updated!==created))return '更新：'+updated;
 return created?'作成：'+created:'';
}
const attribution=document.createElement('dl');
attribution.className='task-attribution';
attribution.setAttribute('aria-label','ToDoの操作記録');
attribution.hidden=true;
$('#editor-error').before(attribution);
function showTodoAttribution(task){
 attribution.replaceChildren();
 attribution.hidden=!task;
 if(!task)return;
 const entries=[['作成',task.createdBy],['最終更新',task.updatedBy]];
 if(task.completed)entries.push(['完了',task.completedBy]);
 for(const [label,actor] of entries){
  const row=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');
  term.textContent=label;value.textContent=actorName(actor)||'記録なし';row.append(term,value);attribution.append(row);
 }
}
function todoRow(x,today){
 const id=html(x.id),label=html(x.title),completed=!!x.completed,late=!completed&&x.dueDate&&x.dueDate<today;
 const date=x.dueDate?dateLabel(x.dueDate):'';
 const actor=todoActorCaption(x);
 const badge=completed?'完了':late?'期限超過':x.dueDate===today?'今日':x.dueDate?date:'期限なし';
 return '<div class="row"><button type="button" class="check" data-toggle="'+id+'" aria-pressed="'+completed+'" aria-label="'+label+'：'+(completed?'未完了に戻す':'完了にする')+'" '+(pending?'disabled':'')+'><span>'+(completed?svg('check'):'')+'</span></button><span class="row-text"><span class="row-title">'+label+'</span>'+((actor||date&&date!==badge)?'<span class="caption task-row-caption">'+(date&&date!==badge?'<span>'+date+'</span>':'')+(actor?'<span>'+html(actor)+'</span>':'')+'</span>':'')+'</span><span class="chip '+(late?'red':completed?'green':'')+'">'+badge+'</span>'+(late?'<button type="button" data-reschedule="'+id+'" aria-label="'+label+'の期限を変更">変更</button>':'')+'<button type="button" class="icon-btn" data-edit="'+id+'" aria-label="'+label+'を編集" title="編集">'+svg('edit')+'</button></div>';
}
function render(){
 const node=$('#primary-content');node.setAttribute('aria-busy',String(loading||pending));
 for(const b of $('#quick-menu').querySelectorAll('[data-create]'))b.disabled=!ready||unauth;
 if(service==='todo'){node.setAttribute('role','tabpanel');node.setAttribute('aria-labelledby','tab-'+view);}
 else {node.removeAttribute('role');node.removeAttribute('aria-labelledby');}
 if(unauth){node.innerHTML='<p class="session-expired"><a href="/auth/start">Googleでログインし直す</a></p>';return;}
 if(!ready){node.innerHTML=loading?'<p class="loading" role="status">読み込み中…</p>':'';return;}
 if(service==='todo'){
  const today=day();
  const list=items.todos.filter(x=>view==='done'?x.completed:!x.completed&&(view==='upcoming'?x.dueDate:!x.dueDate)).sort((a,b)=>view==='upcoming'?String(a.dueDate).localeCompare(String(b.dueDate))||String(b.updatedAt).localeCompare(String(a.updatedAt)):String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const empty={upcoming:'期限のあるToDoはありません。',inbox:'期限を設定していないToDoはありません。',done:'完了したToDoはありません。'};
  node.innerHTML=panel(views[view][0],list.length+'件',list.map(x=>todoRow(x,today)).join('')||'<p class="empty">'+empty[view]+'</p>',action('todo'));
 }else{
   const words=normalize(search).trim().split(/\s+/).filter(Boolean);
   const list=items.notes.filter(x=>words.every(w=>normalize(x.title+' '+x.body).includes(w))).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
   node.innerHTML=list.length?'<div class="notes-grid">'+list.map(x=>'<button type="button" class="card note-card" data-edit="'+html(x.id)+'" aria-label="'+html(x.title)+'を編集"><strong>'+html(x.title)+'</strong><span class="caption">'+html(x.body||'本文なし')+'</span><span class="note-date">'+html(fmtTime(x.updatedAt))+'</span></button>').join('')+'</div>':panel('メモ',words.length?'0件':'', '<p class="empty">'+(words.length?'一致するメモがありません。':'メモはまだありません。')+'</p>',action('notes'));
 }
}
function renderAll(){renderNav();render();}
function drawer(value,restore=false){$('#side').classList.toggle('open',value);$('#scrim').classList.toggle('visible',value);$('#scrim').hidden=!value;$('#menu-button').setAttribute('aria-expanded',String(value));$('#main').inert=value;$('#screenbar').inert=value;if(restore)$('#menu-button').focus();if(value)$('#services [aria-current=page]')?.focus();}
function quick(value,restore=false){$('#quick-menu').hidden=!value;$('#quick').setAttribute('aria-expanded',String(value));if(restore)$('#quick').focus();if(value)$('#quick-menu button:not(:disabled)')?.focus();}
function changeService(k,navigate=false){const next=asService(k);if(!next)return;service=next;pref('service',k);if(navigate)history.pushState(null,'','#'+k);renderAll();window.scrollTo(0,0);}
function changeView(k,source){const next=asView(k);if(!next)return;view=next;pref('todo-tab',k);renderAll();(source==='bar'?$('#screenbar').querySelector('[data-view="'+k+'"]'):$('#tab-'+k))?.focus();window.scrollTo(0,0);}
function flash(s){const o=$('#toast');o.textContent=s;o.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{o.hidden=true},2200);}
function pageError(msg,retry=false){const e=$('#page-error');e.replaceChildren(document.createTextNode(msg));if(retry){e.append(document.createTextNode(' '));const b=document.createElement('button');b.type='button';b.id='retry-load';b.textContent='再試行';e.append(b);}e.hidden=!msg;}
function editorError(msg,reload=false){const e=$('#editor-error');e.replaceChildren(document.createTextNode(msg));if(reload){const b=document.createElement('button');b.type='button';b.id='reload-draft';b.textContent='最新を読み込む（下書きは保持）';e.append(b);}e.hidden=!msg;}
const errorText={unauthorized:'ログインの有効期限が切れました。',forbidden:'この操作は許可されていません。',not_found:'この項目は見つかりません。',invalid_input:'入力内容を確認してください。',version_conflict:'別の画面で変更されています。最新の状態を確認してください。',quota_exceeded:'保存できる件数の上限に達しました。',payload_too_large:'入力が長すぎます。'};
function errorMessage(e,fallback){return errorText[e.code]||fallback;}
async function request(path,method='GET',body){
  let res;try{res=await fetch(path,{method,cache:'no-store',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw {code:'unavailable',uncertain:method!=='GET'};}
  if(res.status===204)return null;
  let data;try{data=await res.json();}catch{throw {code:'unavailable',uncertain:method!=='GET'};}
  if(!res.ok)throw {code:data?.error||(res.status===401?'unauthorized':res.status===403?'forbidden':'unavailable'),uncertain:method!=='GET'&&res.status>=500};
  return data;
}
function expire(){unauth=true;ready=false;items={todos:[],notes:[]};search='';$('#note-search').value='';pageError(errorText.unauthorized);if($('#editor').open){active=null;$('#editor').close();}render();}
async function load({keepError=false}={}){
 if(loading||pending||unauth)return false;loading=true;render();
 try{const response=await request('/api/home');if(!Array.isArray(response?.todos)||!Array.isArray(response?.notes))throw {code:'unavailable'};items=response;ready=true;if(!keepError)pageError('');return true;}
 catch(e){if(e.code==='unauthorized')expire();else pageError(errorMessage(e,'読み込めませんでした。'),true);return false;}
 finally{loading=false;render();}
}
function setPending(v){
 pending=v;
 for(const id of ['save-entry','ask-delete','confirm-delete','editor-close'])$('#'+id).disabled=v;
 $('#primary-content').setAttribute('aria-busy',String(v||loading));
 for(const b of $('#primary-content').querySelectorAll('[data-toggle]'))b.disabled=v;
}
function formValues(k){return {title:$('#entry-title').value,...(k==='todo'?{dueDate:$('#entry-date').value||null}:{body:$('#entry-body').value})};}
function equalValues(a,b,k){return a.title.trim()===b.title.trim()&&(k==='todo'?a.dueDate===b.dueDate:a.body===b.body);}
function openEditor(k,x,trigger,date=false){
  if(!ready||unauth||pending||loading)return;
  active={kind:k,id:x?.id??null,version:x?.version??null,trigger,mode:date?'date':'full',blocked:false};
  $('#editor-title').textContent=date?'期限を変更':services[k][0]+(x?'を編集':'を追加');
  $('#entry-title').value=x?.title??'';$('#entry-date').value=x?.dueDate??'';$('#entry-body').value=x?.body??'';
  $('#title-row').hidden=date;$('#entry-title').required=!date;
  $('#date-row').hidden=k!=='todo';$('#body-row').hidden=k!=='notes';
  $('#ask-delete').hidden=!x||date;showTodoAttribution(k==='todo'&&!date?x:null);$('#confirm-row').hidden=$('#leave-row').hidden=true;editorError('');setPending(false);
  active.before=formValues(k);
  $('#editor').showModal();(date?$('#entry-date'):$('#entry-title')).focus();
}
function closeEditor(force=false){
  if(pending||!active)return;
  if(!force&&!equalValues(formValues(active.kind),active.before,active.kind)){ $('#confirm-row').hidden=true;$('#leave-row').hidden=false;$('#cancel-leave').focus();return; }
  $('#editor').close();
}
function upsert(k,x,id){const a=items[collection(k)];const i=a.findIndex(v=>String(v.id)===String(id??x?.id));if(x===null){if(i>=0)a.splice(i,1);}else if(i>=0)a[i]=x;else a.unshift(x);}
function endpoint(k,id){return '/api/'+collection(k)+(id===null?'':'/'+encodeURIComponent(id));}
async function save(remove=false){
 if(!active||pending||loading||active.blocked)return;
 const a=active,x=formValues(a.kind);if((!remove&&!x.title.trim())||x.title.trim().length>120)return;
 const body=remove?{version:a.version}:a.mode==='date'?{dueDate:x.dueDate,version:a.version}:{...x,title:x.title.trim(),...(a.id===null?{}:{version:a.version})};
 setPending(true);editorError('');
 try{
  const saved=await request(endpoint(a.kind,a.id),remove?'DELETE':a.id===null?'POST':'PATCH',body);
  if(!remove&&(saved?.id==null||!Number.isInteger(saved.version)))throw {code:'unavailable',uncertain:true};
  upsert(a.kind,saved,a.id);
  active=null;$('#editor').close();
  if(!remove){changeService(a.kind,service!==a.kind);if(a.kind==='todo'){view=saved.completed?'done':saved.dueDate?'upcoming':'inbox';pref('todo-tab',view);}else{search='';$('#note-search').value='';}}
  renderAll();$('#main').focus();flash(remove?'削除しました':'保存しました');
 }catch(e){
  if(e.code==='unauthorized'){expire();return;}
  if(e.code==='version_conflict'||e.code==='not_found'||e.uncertain){a.blocked=true;$('#confirm-row').hidden=true;editorError(e.uncertain?'保存結果を確認できませんでした。再送する前に、変更が反映されたか確認してください。':errorMessage(e,'更新できませんでした。'),true); }
  else editorError(errorMessage(e,'保存できませんでした。入力を残しています。'));
 }finally{setPending(false); if(active?.blocked)$('#save-entry').disabled=$('#ask-delete').disabled=true;}
}
async function toggleTodo(id){
 if(pending||loading||unauth)return;const x=find('todo',id);if(!x)return;
 setPending(true);pageError('');
 try{const saved=await request(endpoint('todo',id),'PATCH',{completed:!x.completed,version:x.version});if(saved?.id==null||!Number.isInteger(saved.version))throw {code:'unavailable',uncertain:true};upsert('todo',saved,id);flash(saved.completed?'完了にしました':'未完了に戻しました');}
 catch(e){if(e.code==='unauthorized'){expire();return;}pageError(errorMessage(e,e.uncertain?'更新結果が不明です。最新の状態を確認してください。':'更新できませんでした。'),true);if(e.uncertain||e.code==='version_conflict'||e.code==='not_found'){setPending(false);await load({keepError:true});}}
 finally{setPending(false);render();(Array.from($('#primary-content').querySelectorAll('[data-toggle]')).find(b=>b.dataset.toggle===String(id))||$('#main')).focus();}
}
async function reloadEditor(){
 if(!active||!active.blocked)return;
 const a=active;if(!await load({keepError:true})||active!==a)return;
 if(a.id===null){editorError('一覧を更新しました。重複を防ぐため、いったん一覧で保存結果を確認してください。入力は閉じるまでは残ります。');return;}
 const recent=find(a.kind,a.id);
 if(!recent){showTodoAttribution(null);editorError('この項目は既に削除されています。入力は閉じるまでは残ります。');return;}
 if(a.kind==='todo'&&a.mode==='full')showTodoAttribution(recent);
 const changed=recent.version!==a.version;
 if(changed){a.version=recent.version;a.before=a.kind==='todo'?{title:recent.title,dueDate:recent.dueDate}:{title:recent.title,body:recent.body};if(a.mode==='date')$('#entry-title').value=recent.title;}
 a.blocked=false;$('#save-entry').disabled=$('#ask-delete').disabled=false;editorError(changed?'最新版を読み込みました。下書きの内容で上書きする前に、以下の最新内容を確認してください。':'一覧を更新しました。下書きを保持しています。');
 if(changed){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='最新の保存内容';pre.textContent=a.kind==='todo'?recent.title+'\n期限：'+(recent.dueDate||'未設定'):recent.title+'\n'+recent.body;details.append(summary,pre);$('#editor-error').append(details);}
}
const dialogTriggers=new WeakMap();
function quickDialog(id,b){const d=$('#'+id);dialogTriggers.set(d,b);d.showModal();}
$('#editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
$('#editor').addEventListener('close',()=>{const trigger=active?.trigger;active=null;$('#editor-form').reset();editorError('');showTodoAttribution(null);if(trigger?.isConnected&&!trigger.disabled)trigger.focus();else $('#main').focus();});
for(const d of document.querySelectorAll('dialog:not(#editor)'))d.addEventListener('close',()=>dialogTriggers.get(d)?.focus());
$('#editor-form').addEventListener('submit',e=>{e.preventDefault();void save();});
$('#note-tools').addEventListener('submit',e=>e.preventDefault());
$('#note-search').addEventListener('input',e=>{search=e.target.value;render();});
document.addEventListener('click',e=>{
 if(!e.target.closest('.quick'))quick(false);
 const b=e.target.closest('button,a');if(!b)return;
 if(b.dataset.serviceLink){e.preventDefault();changeService(b.dataset.serviceLink,true);if($('#side').classList.contains('open')){drawer(false);$('#main').focus();}else $('#services [aria-current=page]')?.focus();return;}
 if(b.dataset.view){changeView(b.dataset.view,b.closest('#screenbar')?'bar':'tab');return;}
 if(b.dataset.create){const fromQuick=b.closest('#quick-menu');quick(false);openEditor(b.dataset.create,null,fromQuick?$('#quick'):b);return;}
 if(b.dataset.edit){const x=find(service,b.dataset.edit);if(x)openEditor(service,x,b);return;}
 if(b.dataset.reschedule){const x=find('todo',b.dataset.reschedule);if(x)openEditor('todo',x,b,true);return;}
 if(b.dataset.toggle){void toggleTodo(b.dataset.toggle);return;}
 if(b.dataset.close){$('#'+b.dataset.close).close();return;}
 switch(b.id){
  case 'menu-button':drawer(b.getAttribute('aria-expanded')!=='true',b.getAttribute('aria-expanded')==='true');break;
  case 'scrim':drawer(false,true);break;
  case 'quick':quick(b.getAttribute('aria-expanded')!=='true',b.getAttribute('aria-expanded')==='true');break;
  case 'settings':quickDialog('settings-dialog',b);break;
  case 'account':quickDialog('account-dialog',b);break;
  case 'toggle-theme':setTheme(theme==='dark'?'light':'dark');break;
  case 'editor-close':closeEditor();break;
  case 'ask-delete':$('#leave-row').hidden=true;$('#confirm-row').hidden=false;$('#cancel-delete').focus();break;
  case 'cancel-delete':$('#confirm-row').hidden=true;$('#ask-delete').focus();break;
  case 'confirm-delete':void save(true);break;
  case 'cancel-leave':$('#leave-row').hidden=true;$('#editor-close').focus();break;
  case 'confirm-leave':closeEditor(true);break;
  case 'retry-load':void load();break;
  case 'reload-draft':void reloadEditor();break;
 }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]')){if(!$('#quick-menu').hidden)quick(false,true);else if($('#side').classList.contains('open'))drawer(false,true);}if(e.target.closest('#tabs')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const k=Object.keys(views),i=k.indexOf(view);changeView(k[e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3],'tab');}});
addEventListener('hashchange',()=>changeService(location.hash.slice(1)||'todo'));matchMedia('(min-width:1024px)').addEventListener('change',()=>drawer(false));
renderAll();void load();
