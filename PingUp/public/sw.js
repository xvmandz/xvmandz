'use strict';
const VERSION='2.0.0-beta.1', CACHE='pingup-static-'+VERSION;
const BASE=new URL('./',self.location.href);
const ASSETS=['offline.html','offline.js','styles.css','calls.css','experience.css','motion.css','app.js','calls.js','experience.js','locales/uk.json','locales/ru.json','locales/en.json','assets/logo.svg','assets/ribbon.svg','assets/icons/icon-192.png','assets/icons/icon-512.png','assets/icons/maskable-512.png','assets/icons/badge-96.png',...['message','send','ringtone','outgoing','end','error','mention'].map(n=>'assets/sounds/'+n+'.wav')];
const ALLOWED=new Set(ASSETS.map(path=>new URL(path,BASE).pathname));
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('pingup-notification-meta',1);request.onupgradeneeded=()=>request.result.createObjectStore('meta');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function binding(){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('meta');const r=tx.objectStore('meta').get('binding');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close();});}
async function bind(value){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(value,'binding');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);});}
async function claim(user,id){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta'),key=`seen:${user}:${id}`;let claimed=false;const r=store.get(key);r.onsuccess=()=>{if(!r.result){store.put(Date.now(),key);claimed=true;}const cleanup=store.openCursor();cleanup.onsuccess=()=>{const c=cleanup.result;if(c){if(String(c.key).startsWith('seen:')&&Date.now()-Number(c.value)>7*86400000)c.delete();c.continue();}};};tx.oncomplete=()=>{db.close();resolve(claimed);};tx.onerror=()=>reject(tx.error);});}
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(path=>new Request(new URL(path,BASE).href,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('pingup-static-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==BASE.origin)return;
 if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match(new URL('offline.html',BASE).href)));return;}
 if(!ALLOWED.has(url.pathname))return; // Never intercept/cache api.php, media.php or private resources.
 const canonical=new URL(url.pathname,url.origin).href;
 event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(canonical))||fetch(event.request)));
});
self.addEventListener('message',event=>{
 if(!event.source?.url||new URL(event.source.url).origin!==BASE.origin)return;
 if(event.data?.type==='activate-update')self.skipWaiting();
 if(event.data?.type==='bind')event.waitUntil(bind(event.data.user_id?{user_id:Number(event.data.user_id)}:null));
 if(event.data?.type==='notify')event.waitUntil(display(Number(event.data.event_id),Number(event.data.user_id)));
 if(event.data?.type==='close-notifications')event.waitUntil(self.registration.getNotifications().then(list=>{for(const n of list)if(event.data.all||n.data?.conversation_id===Number(event.data.conversation_id)||n.data?.call_id===Number(event.data.call_id))n.close();}));
});
async function display(eventId,userId){
 const owner=await binding();if(!owner||owner.user_id!==userId||!Number.isSafeInteger(eventId)||eventId<=0)return;
 let data;
 try{const url=new URL('api.php',BASE);url.searchParams.set('action','notifications.resolve');url.searchParams.set('event_id',eventId);url.searchParams.set('system','1');const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(!response.ok)return;const result=await response.json();data=result.ok?result.data:null;}catch{return;}
 if(!data)return;
 const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 // Open focused clients handle their own in-app notification; they also mark the chat read.
 if(windows.some(client=>client.focused&&client.visibilityState==='visible')){for(const client of windows)client.postMessage({type:'notification-event',event_id:eventId});return;}
 if(!await claim(userId,eventId))return;
 const actions=data.kind==='call'?[{action:'answer',title:data.accept},{action:'decline',title:data.decline}]:[];
 await self.registration.showNotification(data.title,{body:data.body,tag:data.tag,icon:new URL('assets/icons/icon-192.png',BASE).href,badge:new URL('assets/icons/badge-96.png',BASE).href,renotify:false,silent:!!data.silent,requireInteraction:data.kind==='call',actions,data:{url:data.url,event_id:eventId,user_id:userId,conversation_id:data.conversation_id||null,call_id:data.call_id||null}});
}
self.addEventListener('push',event=>event.waitUntil((async()=>{try{const data=event.data?.json();if(data)await display(Number(data.event_id),Number(data.user_id));}catch{/* No plaintext message payloads or provider errors logged. */}})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
   const data=event.notification.data||{},owner=await binding();if(!owner||owner.user_id!==data.user_id)return;
   if(event.action==='decline'&&data.call_id){
     try{const response=await fetch(new URL('api.php?action=bootstrap',BASE),{credentials:'same-origin',cache:'no-store'}),bootstrap=await response.json();if(bootstrap.data?.user?.id===owner.user_id)await fetch(new URL('api.php?action=calls.end',BASE),{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':bootstrap.data.csrf},body:JSON.stringify({call_id:data.call_id})});}catch{}
     return;
   }
   const target=new URL(data.url||'./',BASE);if(target.origin!==BASE.origin)return;
   if(event.action==='answer')target.searchParams.set('answer','1');
   const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
   const existing=windows.find(client=>new URL(client.url).pathname.startsWith(BASE.pathname));
   if(existing){await existing.focus();existing.postMessage({type:'open-notification',url:target.href});}
   else await self.clients.openWindow(target.href);
 })());
});
self.addEventListener('pushsubscriptionchange',event=>event.waitUntil((async()=>{for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'subscription-changed'});})()));
