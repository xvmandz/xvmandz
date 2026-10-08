'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {chromium}=require('playwright');
const base=process.env.PINGUP_TEST_URL||'http://127.0.0.1:8182/';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Isolated server only');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PINGUP_BROWSER_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const errors=[],contexts=[];
 try{
  const people=[];const password=crypto.randomBytes(24).toString('base64url')+'A1!';
  for(let i=0;i<3;i++){
   const context=await browser.newContext({viewport:{width:1920,height:1080},permissions:['microphone','camera','notifications']});contexts.push(context);
   const guest=await context.request.get(base+'api.php?action=bootstrap').then(r=>r.json());
   const username='exp'+crypto.randomBytes(5).toString('hex');
   const registered=await context.request.post(base+'api.php?action=auth.register',{headers:{'X-CSRF-Token':guest.data.csrf},data:{name:'Experience '+i,username,password,locale:'en'}}).then(r=>r.json());assert(registered.ok);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   const person={context,page,...registered.data};
   person.api=async(action,data={},post=false)=>{const url=new URL('api.php',base);url.searchParams.set('action',action);if(!post)for(const [k,v]of Object.entries(data))url.searchParams.set(k,v);const response=post?await context.request.post(url.href,{headers:{'X-CSRF-Token':person.csrf},data}):await context.request.get(url.href);const result=await response.json();assert(result.ok,action+': '+JSON.stringify(result.error));return result.data;};
   people.push(person);
  }
  const [a,b,c]=people;
  const conv=await a.api('conversations.create',{type:'direct',user_id:b.user.id},true);
  await b.api('notifications.settings',{preview:true},true);
  await b.page.goto(base);await b.page.locator('.app-shell').waitFor();await b.page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
  const send=(text)=>a.api('messages.send',{conversation_id:conv.id,text,client_id:'browser:'+crypto.randomUUID()},true);
  await send('Foreground notification sample');await b.page.locator('.message-notification').filter({hasText:'Foreground notification sample'}).waitFor({timeout:10000});
  await b.page.locator('.message-notification').click();await b.page.locator('#message-input').waitFor();
  await send('Active chat stays quiet');await b.page.waitForTimeout(3000);assert.equal(await b.page.locator('.message-notification').count(),0);
  await b.page.locator('[data-page="home"]').first().click();
  await b.api('notifications.settings',{preview:false},true);await send('PRIVATE_TEXT_NOT_IN_NOTIFICATION');await b.page.locator('.message-notification').waitFor({timeout:10000});assert(!(await b.page.locator('.message-notification').innerText()).includes('PRIVATE_TEXT_NOT_IN_NOTIFICATION'));
  await b.page.waitForTimeout(7500);assert.equal(await b.page.locator('.message-notification').count(),0,'Repeated polling created duplicate toast');
  await b.page.locator('[data-page="settings"]').first().click();await b.page.locator('.notification-preferences').waitFor();
  await b.page.locator('[data-ui-scale="large"]').click();await b.page.waitForFunction(()=>document.documentElement.dataset.uiScale==='large');
  await b.page.reload();await b.page.locator('.app-shell').waitFor();assert.equal(await b.page.locator('html').getAttribute('data-ui-scale'),'large');
  await b.page.locator('[data-page="settings"]').first().click();await b.page.locator('[data-ui-scale="comfortable"]').click();
  for(const size of [[1366,768],[1920,1080],[2560,1440],[3840,2160],[820,1180],[390,844]]){
   await b.page.setViewportSize({width:size[0],height:size[1]});
   for(const section of ['home','chats','settings','profile']){
    await b.page.locator('[data-page="'+section+'"]').filter({visible:true}).first().click();
    await b.page.keyboard.press('Control+k');const modal=await b.page.locator('#modal').boundingBox();assert(modal&&modal.x>=0&&modal.x+modal.width<=size[0]+1&&modal.y>=-1&&modal.y+modal.height<=size[1]+1,'Modal clipped at '+size);await b.page.keyboard.press('Escape');
    const overflow=await b.page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,section+' overflow '+size+': '+overflow);
   }
  }
  await b.page.setViewportSize({width:1920,height:1080});await b.page.locator('[data-page="settings"]').first().click();for(const scale of ['compact','standard','comfortable','large']){await b.page.locator('[data-ui-scale="'+scale+'"]').click();await b.page.waitForFunction(value=>document.documentElement.dataset.uiScale===value,scale);assert((await b.page.evaluate(()=>document.documentElement.scrollWidth-innerWidth))<=1);}await b.page.locator('[data-ui-scale="comfortable"]').click();
  await b.page.setViewportSize({width:390,height:844});await b.page.locator('.mobile-nav [data-page="chats"]').click();await b.page.locator('[data-open-conversation="'+conv.id+'"]').first().click();await b.page.locator('#message-input').waitFor();
  await b.page.setViewportSize({width:390,height:450});const inputRect=await b.page.locator('#message-input').boundingBox();assert(inputRect.y+inputRect.height<=451,'Composer clipped at keyboard-sized viewport');
  const caches=await b.page.evaluate(async()=>{const result=[];for(const name of await window.caches.keys()){for(const request of await (await window.caches.open(name)).keys())result.push(request.url);}return result;});assert(caches.length>10);assert(!caches.some(url=>/api\.php|media\.php|index\.php/.test(url)),'Private resource cached by SW');
  await b.context.setOffline(true);await b.page.reload();await b.page.locator('#offline-title').waitFor();assert(await b.page.locator('#offline-title').innerText());await b.context.setOffline(false);await b.page.locator('#offline-retry').click();await b.page.locator('.app-shell').waitFor({timeout:15000});
  assert.deepEqual(errors,[]);
  console.log('PASS: notification privacy/dedup/active-chat suppression; persisted scale; 6 viewports; keyboard-sized viewport; static-only SW cache; offline recovery.');
 }catch(e){for(const person of contexts){for(const page of person.pages()){console.error('QA page',page.url(),(await page.locator('body').innerText().catch(()=>'' )).slice(0,400));}}console.error('Browser errors',errors);throw e;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
