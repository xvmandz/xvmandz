/* Notifications, original sounds, installation and appearance. No private Cache storage. */
(() => {
'use strict';
const defaults={sounds:true,message_sound:true,send_sound:true,call_sound:true,volume:.35,dnd:false,system:false,preview:false,scale:'comfortable',motion:true};
let hooks,settings={...defaults},registration,userId=null,installPrompt=null,hasSubscription=false,ring=null,ringRelease=null,ringPending=false,callId=null,callState=null,callNoticeId=null,renewTimer=null;
const tab=crypto.randomUUID?.()||String(Math.random());
const audio=new Map();let unlocked=false;
const tr=key=>hooks?.t(key)||key;
const api=(action,data={},post=false)=>hooks.api(action,data,post?{method:'POST'}:{});
function sound(name,loop=false){
 if(!unlocked||!settings.sounds||settings.dnd||!userId)return null;
 if((name==='message'||name==='mention')&&!settings.message_sound||name==='send'&&!settings.send_sound||['ringtone','outgoing'].includes(name)&&!settings.call_sound)return null;
 let player=audio.get(name);if(!player){player=new Audio(new URL('assets/sounds/'+name+'.wav',location.href).href);player.preload='auto';audio.set(name,player);}
 player.volume=settings.volume;player.loop=loop;player.currentTime=0;player.play().catch(()=>{if(loop){ring=null;ringPending=false;ringRelease?.();ringRelease=null;}});return player;
}
function stopRingtone(){ringPending=false;if(ring){ring.pause();ring.currentTime=0;ring=null;}ringRelease?.();ringRelease=null;}
function ringtone(name){
 if(ring||ringPending||settings.dnd||!settings.sounds||!settings.call_sound)return;
 ringPending=true;
 const start=()=>{if(!ringPending)return;ring=sound(name,true);if(!ring)ringPending=false;};
 if(navigator.locks){navigator.locks.request('pingup-ring-'+userId,{ifAvailable:true},async lock=>{if(!lock){ringPending=false;return;}start();if(ring)await new Promise(resolve=>{ringRelease=resolve;});}).catch(()=>{ringPending=false;});}
 else if(!document.hidden){start();} // Older browsers ring in the visible tab only.
}
function outboxDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('pingup-private-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('pending',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function outboxWork(mode,work){const db=await outboxDB();return new Promise((resolve,reject)=>{const tx=db.transaction('pending',mode);let value;try{value=work(tx.objectStore('pending'));}catch(error){tx.abort();reject(error);return;}tx.oncomplete=()=>{db.close();resolve(value?.result);};tx.onerror=()=>{db.close();reject(tx.error);};});}
async function queue(message){
 if(!userId)return;
 // Private pending user input, never API responses/tokens/file bytes, in user-scoped IndexedDB.
 const key=userId+':'+message.client_id;
 try{await outboxWork('readwrite',store=>store.put({key,user_id:userId,message:JSON.parse(JSON.stringify(message))}));}
 catch{if(!navigator.onLine)hooks.toast(tr('notify.outbox_unavailable'),'error');}
}
async function ack(clientId){if(!userId||!clientId)return;try{await outboxWork('readwrite',store=>store.delete(userId+':'+clientId));}catch{}}
async function clearOutbox(id){try{await outboxWork('readwrite',store=>{const r=store.openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(c.value.user_id===id)c.delete();c.continue();}};return r;});}catch{}}
async function restoreOutbox(){
 try{const rows=await outboxWork('readonly',store=>store.getAll());for(const row of rows||[])if(row.user_id===userId&&hooks.hasChat(Number(row.message.conversation_id)))hooks.restoreQueued(row.message);if(navigator.onLine)hooks.retryQueued();}catch{}
}
function apply(){document.documentElement.dataset.motion=settings.motion?'on':'off';document.documentElement.dataset.uiScale=settings.scale;document.documentElement.style.setProperty('--ui-factor',{compact:.9,standard:1,comfortable:1.1,large:1.25}[settings.scale]||1.1);for(const player of audio.values())player.volume=settings.volume;if(settings.dnd||!settings.sounds||!settings.call_sound)stopRingtone();}
async function save(patch){settings=await api('notifications.settings',patch,true);apply();hooks.onSettings?.(settings);mount();return settings;}
function workerMessage(data){const worker=registration?.active||navigator.serviceWorker?.controller;if(worker)worker.postMessage(data);}
async function register(){
 if(!('serviceWorker'in navigator)||!window.isSecureContext)return;
 try {
  registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});
  registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)updateNotice();});});
  await navigator.serviceWorker.ready;
  workerMessage({type:'bind',user_id:userId});hasSubscription=!!(await registration.pushManager.getSubscription());await renew();mount();if(registration.waiting)updateNotice();
 }catch{hooks?.toast(tr('pwa.register_failed'),'error');}
}
function updateNotice(){let button=document.querySelector('#pwa-update');if(button)return;button=document.createElement('button');button.id='pwa-update';button.className='pwa-update secondary-button';button.textContent=tr('pwa.update');button.onclick=()=>{if(callId){hooks.toast(tr('pwa.update_after_call'));return;}registration.waiting?.postMessage({type:'activate-update'});};document.body.append(button);}
async function enablePush(){
 if(!window.isSecureContext||!('Notification'in window)||!('PushManager'in window)||!('serviceWorker'in navigator)){hooks.toast(tr('notify.unsupported'),'error');return;}
 const permission=await Notification.requestPermission(); // Called only from the Enable button.
 if(permission!=='granted'){hooks.toast(tr('settings.notifications_denied'),'error');return;}
 try{
  if(!registration)await register();const info=await api('push.status');
  if(!info.enabled){hooks.toast(tr('notify.not_configured'),'error');return;}
  const publicBytes=Uint8Array.from(atob(info.public_key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  let sub=await registration.pushManager.getSubscription();if(!sub)sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicBytes});
  await api('push.subscribe',sub.toJSON(),true);hasSubscription=true;await save({system:true});workerMessage({type:'bind',user_id:userId});hooks.toast(tr('notify.enabled'),'success');
 }catch{hooks.toast(tr('notify.enable_failed'),'error');}
}
async function disablePush(clearBinding=false){hasSubscription=false;if(clearBinding)await clearOutbox(userId);
 try {const sub=await registration?.pushManager.getSubscription();if(sub){await api('push.unsubscribe',{endpoint:sub.endpoint},true);await sub.unsubscribe();}}catch{}
 if(clearBinding){workerMessage({type:'bind',user_id:null});workerMessage({type:'close-notifications',all:true});}
 else await save({system:false});
}
async function renew(){
 if(!userId||!registration||!settings.system||Notification.permission!=='granted')return;
 try {const sub=await registration.pushManager.getSubscription();if(sub)await api('push.subscribe',sub.toJSON(),true);}catch{}
}
function mount(){
 const update=document.querySelector('#pwa-update');if(update)update.textContent=tr('pwa.update');
 if(!hooks||!userId)return;
 const grid=document.querySelector('.settings-grid');if(!grid)return;
 let card=grid.querySelector('.notification-preferences');
 if(!card){card=document.createElement('article');card.className='settings-card notification-preferences';grid.prepend(card);}
 card.replaceChildren();const title=document.createElement('h2');title.textContent=tr('notify.settings');card.append(title);
 for(const [key,label]of [['motion','motion.enabled'],['sounds','notify.sounds'],['message_sound','notify.message_sound'],['send_sound','notify.send_sound'],['call_sound','notify.call_sound'],['dnd','settings.quiet'],['preview','notify.preview']]) {
  const row=document.createElement('label');row.className='preference-toggle';const span=document.createElement('span');span.textContent=tr(label);const input=document.createElement('input');input.type='checkbox';input.checked=settings[key];input.dataset.notificationSetting=key;row.append(span,input);card.append(row);
 }
 const volume=document.createElement('label');volume.className='preference-volume';volume.textContent=tr('notify.volume');const range=document.createElement('input');range.type='range';range.min=0;range.max=100;range.value=String(Math.round(settings.volume*100));range.dataset.notificationVolume='';volume.append(range);card.append(volume);
 const system=document.createElement('button');system.type='button';system.className='secondary-button';system.dataset.pushToggle='';system.textContent=tr(settings.system&&hasSubscription?'notify.disable':'notify.enable');card.append(system);
 const note=document.createElement('p');note.className='setting-note';note.textContent=tr('notify.autoplay_hint');card.append(note);
 let appearance=grid.querySelector('.ui-scale-options');if(!appearance){appearance=document.createElement('div');appearance.className='ui-scale-options';grid.querySelector('.theme-options')?.parentElement.append(appearance);}
 appearance.replaceChildren();const scaleLabel=document.createElement('h3');scaleLabel.textContent=tr('appearance.scale');appearance.append(scaleLabel);
 for(const [value,percent]of [['compact','90%'],['standard','100%'],['comfortable','110%'],['large','125%']]){const button=document.createElement('button');button.className='secondary-button'+(settings.scale===value?' selected':'');button.dataset.uiScale=value;button.textContent=tr('appearance.'+value)+' · '+percent;button.setAttribute('aria-pressed',String(settings.scale===value));appearance.append(button);}
 let pwa=grid.querySelector('.pwa-preferences');if(!pwa){pwa=document.createElement('article');pwa.className='settings-card pwa-preferences';grid.append(pwa);}pwa.replaceChildren();const h=document.createElement('h2');h.textContent=tr('pwa.title');const hint=document.createElement('p');hint.textContent=tr(matchMedia('(display-mode: standalone)').matches?'pwa.installed':'pwa.install_hint');pwa.append(h,hint);
 if(!matchMedia('(display-mode: standalone)').matches){const button=document.createElement('button');button.className='secondary-button';button.dataset.installPingup='';button.textContent=tr('pwa.install');pwa.append(button);}
 grid.querySelector('[data-action="notifications"]')?.closest('.settings-card')?.remove();
}
async function claim(event){
 // Serialize a localStorage high-water mark across tabs when Web Locks is supported.
 const work=()=>{const key=`pingup.seen.${userId}`;let seen=[];try{seen=JSON.parse(localStorage.getItem(key)||'[]');}catch{}
  if(seen.includes(event.event_id))return false;seen.push(event.event_id);try{localStorage.setItem(key,JSON.stringify(seen.slice(-500)));}catch{}return true;};
 return navigator.locks?navigator.locks.request('pingup-notification-'+userId,work):work();
}
async function events(list){
 for(const event of list||[]){
  if(settings.dnd||event.kind==='call')continue;
  if(hooks.activeChat()===event.conversation_id&&document.hasFocus()&&!document.hidden)continue;
  if(!await claim(event))continue;
  if(!document.hidden&&document.hasFocus()) {
   const button=document.createElement('button');button.className='toast message-notification';const title=document.createElement('strong');title.textContent=event.title;const body=document.createElement('span');body.textContent=event.body;button.append(title,body);button.onclick=()=>{hooks.openChat(event.conversation_id);button.remove();};document.querySelector('#toasts').append(button);setTimeout(()=>button.remove(),6000);sound(event.kind==='mention'?'mention':'message');
  } else if(settings.system&&Notification.permission==='granted') {
   workerMessage({type:'notify',event_id:event.event_id,user_id:userId});
  }
 }
}
async function openURL(raw){let url;try{url=new URL(raw,location.href);}catch{return;}if(url.origin!==location.origin)return;
 const invite=url.searchParams.get('invite');if(invite&&hooks?.joinInvite){await hooks.joinInvite(invite);url.searchParams.delete('invite');history.replaceState(null,'',url.href);}
 const chat=Number(url.searchParams.get('chat'));if(Number.isSafeInteger(chat)&&chat>0&&hooks?.hasChat(chat))await hooks.openChat(chat);
 if(url.searchParams.has('call')){hooks?.refreshCalls();if(url.searchParams.get('answer')==='1')hooks?.toast(tr('notify.answer_in_app'));}
}
function call(call){
 if(callId!==call.id){stopRingtone();callId=call.id;callState=null;}
 if(callState!==call.status){stopRingtone();callState=call.status;}
 if(call.status==='ringing')ringtone(call.incoming?'ringtone':'outgoing');
 if(callNoticeId!==call.id&&call.incoming&&call.status==='ringing'&&settings.system&&(document.hidden||!document.hasFocus())&&call.notification_event_id){callNoticeId=call.id;workerMessage({type:'notify',event_id:call.notification_event_id,user_id:userId});}
}
function callEnd(){const hadCall=!!callId;workerMessage({type:'close-notifications',call_id:callId});stopRingtone();callId=null;callState=null;callNoticeId=null;if(hadCall)sound('end');}
function callConnected(){workerMessage({type:'close-notifications',call_id:callId});stopRingtone();callState='active';}
async function init(data){userId=data.user?.id||null;settings={...defaults,...data.notification_settings};apply();hooks.onSettings?.(settings);workerMessage({type:'bind',user_id:userId});clearInterval(renewTimer);if(userId){renew();renewTimer=setInterval(renew,3600000);await restoreOutbox();openURL(location.href);}}
function stop(){callEnd();clearInterval(renewTimer);userId=null;workerMessage({type:'bind',user_id:null});workerMessage({type:'close-notifications',all:true});for(const player of audio.values())player.pause();}
document.addEventListener('pointerdown',()=>{unlocked=true;if(callId&&callState==='ringing')ringtone('ringtone');},{passive:true});
document.addEventListener('keydown',()=>{unlocked=true;},{passive:true});
document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button||!hooks)return;
 try {
  if(button.hasAttribute('data-push-toggle')){if(settings.system&&hasSubscription)await disablePush();else await enablePush();}
  if(button.dataset.uiScale)await save({scale:button.dataset.uiScale});
  if(button.hasAttribute('data-install-pingup')){if(installPrompt){await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;mount();}else hooks.toast(tr('pwa.install_hint'));}
  if(button.dataset.chatNotify){const id=Number(button.dataset.chatNotify),conv=hooks.getChat(id);const modes=conv.type==='direct'?['all','none']:['all','mentions','none'];const mode=modes[(modes.indexOf(conv.notification_mode||'all')+1)%modes.length];await api('notifications.chat',{conversation_id:id,mode},true);conv.notification_mode=mode;button.title=tr('notify.mode_'+mode);button.setAttribute('aria-label',tr('notify.mode_'+mode));button.dataset.mode=mode;}
 }catch{hooks.toast(tr('common.error'),'error');sound('error');}
});
document.addEventListener('change',event=>{const key=event.target.dataset.notificationSetting;if(key)save({[key]:event.target.checked}).catch(()=>hooks.toast(tr('common.error'),'error'));if(event.target.hasAttribute('data-notification-volume'))save({volume:Number(event.target.value)/100}).catch(()=>{});});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;mount();});window.addEventListener('appinstalled',()=>{installPrompt=null;mount();});
window.addEventListener('online',()=>{hooks?.reconnect();renew();registration?.update();});
window.addEventListener('offline',()=>hooks?.offline());
window.addEventListener('pageshow',()=>hooks?.reconnect());
if('serviceWorker'in navigator){navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='open-notification')openURL(event.data.url);if(event.data?.type==='notification-event')hooks?.reconnect();if(event.data?.type==='subscription-changed')hooks?.toast(tr('notify.resubscribe'));});navigator.serviceWorker.addEventListener('controllerchange',()=>{if(document.querySelector('#pwa-update')&&!callId)location.reload();});}
if(window.visualViewport){const viewport=()=>{document.documentElement.style.setProperty('--app-height',window.visualViewport.height+'px');};window.visualViewport.addEventListener('resize',viewport);viewport();}
window.PingUpExperience=Object.freeze({configure(options){hooks=options;register();},init,stop,mount,events,sound,queue,ack,call,callEnd,callConnected,enablePush,disablePush,save,updateSettings(value){settings={...defaults,...value};apply();hooks?.onSettings?.(settings);},chatRead(id){workerMessage({type:'close-notifications',conversation_id:id});}});
})();
