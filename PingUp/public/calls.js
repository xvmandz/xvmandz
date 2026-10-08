/* PingUp WebRTC calls. No media is captured until Start or Accept is pressed. */
(() => {
  'use strict';
  const fallback = {
    audioCall:'Audio call',videoCall:'Video call',incoming:'Incoming call',calling:'Calling…',connecting:'Connecting…',connected:'Connected',ended:'Call ended',rejected:'Call declined',accept:'Accept',decline:'Decline',hangup:'End call',mute:'Mute microphone',unmute:'Enable microphone',cameraOn:'Enable camera',cameraOff:'Disable camera',close:'Close',secureRequired:'Calling requires HTTPS or localhost.',unsupported:'This browser does not support calling.',mediaDenied:'Allow microphone and camera access to call.',failed:'Unable to connect the call.',disconnected:'Connection lost',historyEmpty:'No calls yet',missed:'Missed call',cancelled:'Cancelled',busy:'This person is already in a call.',timeout:'No answer'
  };
  const icons = {
    phone:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.8 2.1Z"/>',
    video:'<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 9 5-3v12l-5-3"/>',
    mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    micOff:'<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5V4a3 3 0 0 1 6 0v6M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8"/>',
    cameraOff:'<path d="m3 3 18 18M10 5h3a3 3 0 0 1 3 3v1l5-3v12l-5-3M16 16v1a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V8"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    incoming:'<path d="M5 5v8h8M5 13 17 1"/>',
    outgoing:'<path d="M5 17 17 5M9 5h8v8"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.phone}</svg>`;
  let hooks = null, timer = null, generation = 0, userId = null;
  let remoteStream = null, negotiation = 0, restartCount = 0, reconnecting = false;
  const deviceId = crypto.randomUUID ? crypto.randomUUID() : `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const diagnostics = [];
  function diagnostic(event, extra={}) { const item={time:new Date().toISOString(),event,...extra};diagnostics.push(item);if(diagnostics.length>100)diagnostics.shift();if(localStorage.getItem("pingup.callDiagnostics")==="true")console.info("PingUp call",item); }
  let active = null, pc = null, stream = null, dialog = null, lastFocus = null;
  let afterId = 0, pendingSignals = [], candidates = [], signalChain = Promise.resolve();
  let polling = false, starting = false, accepting = false, durationTimer = null, connectionTimer = null, disconnectTimer = null;
  let acceptedOffer = false, muted = false, cameraDisabled = false, connectedAt = null;
  const ignored = new Set();
  const tr = key => {
    const result = hooks?.t?.(`calls.${key}`);
    return !result || result === `calls.${key}` ? (fallback[key] || key) : result;
  };
  const api = (action, data = {}, post = false) => hooks.api(action, {...data,device_id:deviceId}, post ? {method:'POST'} : {method:'GET'});
  const notify = text => { hooks?.notify?.(text, 'error'); };
  function supported() {
    if (!window.isSecureContext) { notify(tr('secureRequired')); return false; }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) { notify(tr('unsupported')); return false; }
    return true;
  }
  function createDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'pu-call-dialog';
    dialog.setAttribute('aria-labelledby','pu-call-name');
    dialog.setAttribute('aria-describedby','pu-call-status');
    dialog.innerHTML = `<div class="pu-call-scene"><div class="pu-call-orbit" aria-hidden="true"></div><div class="pu-call-top"><span class="pu-call-kind"></span><button type="button" class="pu-call-close" data-call="close">${svg('close')}</button></div><video class="pu-call-remote" autoplay playsinline></video><audio class="pu-call-audio" autoplay></audio><div class="pu-call-person"><div class="pu-call-avatar"></div><h2 id="pu-call-name"></h2><p id="pu-call-status" role="status" aria-live="polite"></p><div class="pu-call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div><video class="pu-call-local" autoplay muted playsinline></video><button type="button" class="pu-call-play" data-call="play" hidden>${svg('phone')}<span></span></button><div class="pu-call-controls"><button type="button" class="pu-call-control" data-call="mic">${svg('mic')}</button><button type="button" class="pu-call-control" data-call="camera">${svg('video')}</button><button type="button" class="pu-call-control pu-call-accept" data-call="accept">${svg('phone')}</button><button type="button" class="pu-call-control pu-call-end" data-call="end">${svg('phone')}</button></div></div>`;
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (active) end(); else closeDialog(); });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-call]');
      if (!button) return;
      switch (button.dataset.call) {
        case 'close': if (active) end(); else closeDialog(); break;
        case 'end': end(); break;
        case 'accept': accept(); break;
        case 'mic': toggleMicrophone(); break;
        case 'camera': toggleCamera(); break;
        case 'play': playback(); break;
      }
    });
  }
  function show(call) {
    createDialog();
    const peer = call.peer || {};
    const avatar = dialog.querySelector('.pu-call-avatar');
    avatar.replaceChildren();
    avatar.style.setProperty('--pu-call-accent', /^#[a-f\d]{6}$/i.test(peer.accent || '') ? peer.accent : '#a78bfa');
    if (peer.avatar_url) {
      const img = document.createElement('img');
      img.src = peer.avatar_url; img.alt = ''; avatar.append(img);
    } else { avatar.textContent = (peer.name || 'P').trim().slice(0, 2).toUpperCase(); }
    dialog.querySelector('#pu-call-name').textContent = peer.name || 'PingUp';
    dialog.querySelector('.pu-call-kind').textContent = tr(call.kind === 'video' ? 'videoCall' : 'audioCall');
    dialog.querySelector('.pu-call-close').setAttribute('aria-label', tr('close'));
    dialog.querySelector('[data-call="accept"]').setAttribute('aria-label',tr('accept'));
    dialog.querySelector('[data-call="play"] span').textContent = tr('connected');
    dialog.dataset.kind = call.kind;
    dialog.dataset.media = 'false';
    if (!dialog.open) { lastFocus = document.activeElement; dialog.showModal(); }
    window.PingUpExperience?.call(call);
    paint();
  }
  function paint(status) {
    if (!dialog) return;
    const incoming = active?.incoming && active?.status === 'ringing';
    const inCall = !!stream && !!active;
    dialog.dataset.state = active?.status || 'ended';
    dialog.dataset.connected = pc?.connectionState === 'connected' ? 'true' : 'false';
    dialog.querySelector('[data-call="accept"]').hidden = !incoming;
    dialog.querySelector('[data-call="accept"]').disabled = accepting;
    dialog.querySelector('[data-call="end"]').hidden = !active;
    dialog.querySelector('[data-call="end"]').setAttribute('aria-label',tr(incoming ? 'decline' : 'hangup'));
    const mic = dialog.querySelector('[data-call="mic"]');
    mic.hidden = !inCall; mic.innerHTML = svg(muted ? 'micOff' : 'mic');
    mic.setAttribute('aria-label',tr(muted ? 'unmute' : 'mute')); mic.setAttribute('aria-pressed',String(muted));
    const camera = dialog.querySelector('[data-call="camera"]');
    camera.hidden = !inCall || active?.kind !== 'video'; camera.innerHTML = svg(cameraDisabled ? 'cameraOff' : 'video');
    camera.setAttribute('aria-label',tr(cameraDisabled ? 'cameraOn' : 'cameraOff')); camera.setAttribute('aria-pressed',String(cameraDisabled));
    dialog.querySelector('.pu-call-local').hidden = !inCall || active?.kind !== 'video' || cameraDisabled;
    if (status) dialog.querySelector('#pu-call-status').textContent = status;
    else if (connectedAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
      dialog.querySelector('#pu-call-status').textContent = `${tr('connected')} · ${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
    } else dialog.querySelector('#pu-call-status').textContent = tr(incoming ? 'incoming' : active?.status === 'active' ? 'connecting' : 'calling');
  }
  function closeDialog() {
    if (dialog?.open) dialog.close();
    if (lastFocus?.isConnected) lastFocus.focus();
    lastFocus = null;
  }
  function clearMedia() {
    clearInterval(durationTimer); clearTimeout(connectionTimer); clearTimeout(disconnectTimer);
    durationTimer = null; connectionTimer = null; disconnectTimer = null;
    if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicegatheringstatechange = null; pc.close(); pc = null; }
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (dialog) for (const media of dialog.querySelectorAll('video,audio')) { media.pause(); media.srcObject = null; }
    remoteStream=null; negotiation=0; restartCount=0; reconnecting=false;
    pendingSignals = []; candidates = []; acceptedOffer = false;
    connectedAt = null; muted = false; cameraDisabled = false;
  }
  function finish(reason = 'ended', dismiss = false) {
    if (active) ignored.add(active.id);
    window.PingUpExperience?.callEnd(reason);
    active = null; accepting = false; starting = false;
    clearMedia();
    paint(tr(reason));
    if (dismiss) closeDialog();
  }
  async function playback() {
    if (!dialog) return;
    const media = dialog.querySelector(dialog.dataset.kind === 'video' ? '.pu-call-remote' : '.pu-call-audio');
    try { await media.play(); dialog.querySelector('.pu-call-play').hidden = true; }
    catch { dialog.querySelector('.pu-call-play').hidden = false; }
  }
  async function capture(kind) {
    const media = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:kind === 'video' ? {width:{ideal:960},height:{ideal:540},frameRate:{ideal:24,max:30},facingMode:'user'} : false});
    return media;
  }
  function sendSignal(type, payload, callId, revision = negotiation) {
    const epoch = generation;
    signalChain = signalChain.catch(() => {}).then(async () => {
      if (epoch !== generation || active?.id !== callId) return;
      for(let attempt=0;attempt<3;attempt++){
        try{await api('calls.signal',{call_id:callId,type,payload,negotiation:revision},true);return;}
        catch(error){if(epoch!==generation||active?.id!==callId)return;if(!['network','storage_busy','rate_limited'].includes(error.code)||attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
      }
    });
    return signalChain;
  }
  function createPeer() {
    if (pc || !active || !stream) return;
    const callId = active.id;
    // An explicit empty list is useful on a private network and must stay empty.
    const iceServers = Array.isArray(hooks.iceServers) ? hooks.iceServers : [{urls:'stun:stun.l.google.com:19302'}];
    remoteStream=new MediaStream();
    pc = new RTCPeerConnection({iceServers,iceCandidatePoolSize:0});
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    dialog.querySelector('.pu-call-local').srcObject = stream;
    pc.onicegatheringstatechange=()=>diagnostic('ice_gathering',{state:pc?.iceGatheringState});
    pc.onicecandidate = event => {
      if (!event.candidate || active?.id !== callId) return;
      diagnostic('ice_candidate',{type:event.candidate.type,protocol:event.candidate.protocol});
      sendSignal('candidate',event.candidate.toJSON(),callId).catch(() => diagnostic('candidate_send_failed'));
    };
    pc.ontrack = event => {
      if (active?.id !== callId) return;
      // Keep one aggregate stream: a late video/audio track must not replace the first track.
      const tracks=event.streams?.[0]?.getTracks() || [event.track];
      for(const track of tracks)if(!remoteStream.getTracks().some(t=>t.id===track.id))remoteStream.addTrack(track);
      const media=dialog.querySelector(active.kind==='video'?'.pu-call-remote':'.pu-call-audio');
      if(media.srcObject!==remoteStream)media.srcObject=remoteStream;
      dialog.dataset.media=active.kind==='video'?'true':'false';
      event.track.addEventListener('mute',()=>diagnostic('remote_track_muted',{kind:event.track.kind}));
      event.track.addEventListener('unmute',()=>{diagnostic('remote_track_resumed',{kind:event.track.kind});playback();});
      diagnostic('remote_track',{kind:event.track.kind});playback();
    };
    pc.onconnectionstatechange = () => {
      if (active?.id !== callId || !pc) return;
      diagnostic('connection_state',{state:pc.connectionState});
      if (pc.connectionState === 'connected') {
        clearTimeout(connectionTimer); clearTimeout(disconnectTimer);
        reconnecting=false;window.PingUpExperience?.callConnected();
        connectedAt ??= Date.now();
        if (!durationTimer) durationTimer = setInterval(() => paint(),1000);
        paint();
      } else if (pc.connectionState === 'failed') recover();
      else if (pc.connectionState === 'disconnected') {
        paint(tr('disconnected'));
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => { if (active?.id === callId) recover(); },12000);
      } else paint();
    };
    pc.oniceconnectionstatechange=()=>{diagnostic('ice_state',{state:pc?.iceConnectionState});if(pc?.iceConnectionState==='failed')recover();};
    connectionTimer = setTimeout(() => { if (active?.id === callId && active.status === 'active' && pc?.connectionState !== 'connected') fail(); },90000);
    paint();
  }
  async function recover() {
    if(!pc||!active||reconnecting)return;
    if(active.incoming){paint(tr('disconnected'));clearTimeout(disconnectTimer);disconnectTimer=setTimeout(()=>{if(pc?.connectionState!=='connected')fail();},45000);return;}
    if(restartCount>=2){fail();return;}
    reconnecting=true;restartCount++;negotiation++;acceptedOffer=false;
    diagnostic('ice_restart',{attempt:restartCount});paint(tr('connecting'));
    const connection=pc,id=active.id;
    try {
      const offer=await connection.createOffer({iceRestart:true});
      if(pc!==connection||active?.id!==id)return;
      await connection.setLocalDescription(offer);
      await sendSignal('offer',connection.localDescription.toJSON(),id);
      clearTimeout(disconnectTimer);disconnectTimer=setTimeout(()=>{reconnecting=false;if(active?.id===id&&pc?.connectionState!=='connected')recover();},30000);
    } catch {reconnecting=false;diagnostic('restart_signal_failed');clearTimeout(disconnectTimer);disconnectTimer=setTimeout(recover,3000);}
  }
  async function applyCandidate(connection,payload) {
    try{await connection.addIceCandidate(payload);}catch{diagnostic('candidate_rejected');}
  }
  async function processSignal(signal) {
    if(!active||signal.call_id!==active.id)return;
    if(!pc||!stream||(active.incoming&&active.status!=='active')){pendingSignals.push(signal);return;}
    const current=active.id,connection=pc,revision=Number(signal.negotiation||0);
    const isCurrent=()=>active?.id===current&&pc===connection;
    if(revision<negotiation)return;
    if(signal.type==='candidate') {
      if(revision!==negotiation||!connection.remoteDescription)candidates.push({revision,payload:signal.payload});
      else await applyCandidate(connection,signal.payload);
      return;
    }
    if(signal.type==='offer'&&active.incoming&&(!acceptedOffer||revision>negotiation)) {
      acceptedOffer=true;negotiation=revision;
      await connection.setRemoteDescription(signal.payload);if(!isCurrent())return;
      for(const candidate of candidates.splice(0)){if(candidate.revision===revision)await applyCandidate(connection,candidate.payload);if(!isCurrent())return;}
      const answer=await connection.createAnswer();if(!isCurrent())return;
      await connection.setLocalDescription(answer);if(isCurrent())await sendSignal('answer',connection.localDescription.toJSON(),current,revision);
    } else if(signal.type==='answer'&&!active.incoming&&revision===negotiation&&connection.signalingState==='have-local-offer') {
      await connection.setRemoteDescription(signal.payload);if(!isCurrent())return;
      for(const candidate of candidates.splice(0)){if(candidate.revision===revision)await applyCandidate(connection,candidate.payload);if(!isCurrent())return;}
    }
  }
  async function mediaStats() {
    if(!pc)return [];
    const rows=[];try{const stats=await pc.getStats();for(const report of stats.values())if(['inbound-rtp','outbound-rtp'].includes(report.type)&&!report.isRemote)rows.push({type:report.type,kind:report.kind,bytesReceived:report.bytesReceived||0,bytesSent:report.bytesSent||0,packetsReceived:report.packetsReceived||0,packetsLost:report.packetsLost||0,totalAudioEnergy:report.totalAudioEnergy||0});for(const report of stats.values())if(report.type==='candidate-pair'&&report.state==='succeeded'&&report.nominated)rows.push({type:'candidate-pair',localType:stats.get(report.localCandidateId)?.candidateType,remoteType:stats.get(report.remoteCandidateId)?.candidateType,roundTripTime:report.currentRoundTripTime});}catch{}
    return rows;
  }
  async function start(peer, kind = 'audio') {
    if (!hooks || !hooks.getUser?.() || starting || active || !peer || !supported()) return;
    if (!['audio','video'].includes(kind)) return;
    starting = true;
    const epoch = generation;
    let captured = null, startedCall = null;
    try {
      captured = await capture(kind);
      if (epoch !== generation || !hooks.getUser?.()) { captured.getTracks().forEach(track => track.stop()); return; }
      const response = await api('calls.start',{user_id:peer.id,kind},true);
      startedCall = response.call;
      if (epoch !== generation || active) {
        captured.getTracks().forEach(track => track.stop());
        await api('calls.end',{call_id:startedCall.id},true).catch(() => {}); return;
      }
      stream = captured; active = response.call; pendingSignals = []; candidates = []; acceptedOffer = false;
      afterId=0;show(active); createPeer();
      const offer = await pc.createOffer();
      if (epoch !== generation || active?.id !== startedCall.id) return;
      await pc.setLocalDescription(offer);
      await sendSignal('offer',pc.localDescription.toJSON(),active.id);
      schedule(100);
    } catch (error) {
      if (captured && captured !== stream) captured.getTracks().forEach(track => track.stop());
      if (epoch !== generation) return;
      const code = error?.code || error?.error || '';
      notify(tr(code === 'call_busy' ? 'busy' : error?.name === 'NotAllowedError' || error?.name === 'NotFoundError' ? 'mediaDenied' : 'failed'));
      if (active && startedCall?.id === active.id) await end();
    } finally { if (epoch === generation) starting = false; }
  }
  async function accept() {
    if (!active?.incoming || active.status !== 'ringing' || accepting || !supported()) return;
    accepting = true; paint(tr('connecting'));
    const callId = active.id, epoch = generation;
    let captured;
    try {
      captured = await capture(active.kind);
      if (epoch !== generation || active?.id !== callId) { captured.getTracks().forEach(track => track.stop()); return; }
      const response = await api('calls.accept',{call_id:callId},true);
      if (epoch !== generation || active?.id !== callId || response.call.status !== 'active') { captured.getTracks().forEach(track => track.stop()); return; }
      active = response.call; stream = captured; window.PingUpExperience?.callConnected(); createPeer();
      for (const signal of pendingSignals.splice(0)) await processSignal(signal);
      paint(); schedule(100);
    } catch (error) {
      if (captured && captured !== stream) captured.getTracks().forEach(track => track.stop());
      if (epoch !== generation) return;
      notify(tr(error?.name === 'NotAllowedError' || error?.name === 'NotFoundError' ? 'mediaDenied' : 'failed'));
      if (active?.id === callId) await end();
    } finally { if (epoch === generation) { accepting = false; paint(); } }
  }
  async function end() {
    const callId = active?.id;
    finish('ended',true);
    if (callId && hooks) await api('calls.end',{call_id:callId},true).catch(() => {});
    schedule(1000);
  }
  function fail() {
    const callId = active?.id;
    finish('failed');
    if (callId && hooks) api('calls.end',{call_id:callId},true).catch(() => {});
    schedule(1000);
  }
  function toggleMicrophone() {
    if (!stream) return;
    muted = !muted; stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); paint();
  }
  function toggleCamera() {
    if (!stream) return;
    cameraDisabled = !cameraDisabled; stream.getVideoTracks().forEach(track => { track.enabled = !cameraDisabled; }); paint();
  }
  function schedule(delay) {
    clearTimeout(timer);
    if (hooks && userId) timer = setTimeout(poll,delay);
  }
  async function poll() {
    if (polling || !hooks || !hooks.getUser?.()) return;
    polling = true;
    const epoch = generation;
    try {
      const response = await api('calls.poll',{after_id:afterId,call_id:active?.id || 0});
      if (epoch !== generation) return;
      const calls = response.calls || [];
      if (active) {
        const fresh = calls.find(call => call.id === active.id);
        if (fresh) {
          active = fresh;
          if (fresh.status === 'ended' || fresh.status === 'rejected') {
            finish(fresh.end_reason === 'timeout' ? 'timeout' : fresh.end_reason === 'disconnected' ? 'disconnected' : fresh.status === 'rejected' ? 'rejected' : 'ended');
          } else if (fresh.status==='active'&&fresh.owned===false&&stream) {
            finish('ended',true);
          } else if (fresh.incoming && fresh.status === 'active' && !stream && !accepting) {
            // This call was accepted in another browser tab; keep this tab's microphone off.
            finish('ended',true);
          } else {window.PingUpExperience?.call(fresh);paint();}
        }
      } else if (!starting) {
        const incoming = calls.find(call => call.incoming && call.status === 'ringing' && !ignored.has(call.id));
        if (incoming) { active = incoming; afterId=0;show(active); }
      }
      for (const signal of response.signals || []) {
        if(!active||signal.call_id!==active.id)continue;
        try{await processSignal(signal);}catch{diagnostic('signal_apply_failed',{type:signal.type});continue;}
        afterId = Math.max(afterId,signal.id);
      }
    } catch (error) {
      if (epoch !== generation) return;
      if (error?.code === 'unauthorized' || error?.status === 401) { stop(); return; }
      // Temporary polling failures preserve the current call; server heartbeats expire it if connectivity is lost.
    } finally {
      polling = false;
      if (epoch === generation) schedule(active ? 1200 : document.hidden ? 6000 : 3000);
    }
  }
  function init(options) {
    const currentId = options?.getUser?.()?.id;
    if (!currentId || !options.api) return;
    if (userId === currentId && hooks) { hooks = options; return; }
    stop(); hooks = options; userId = currentId; afterId = 0; ignored.clear();
    schedule(50);
  }
  function stop() {
    const callId = active?.id, previous = hooks;
    generation++; clearTimeout(timer); timer = null;
    finish('ended',true); hooks = null; userId = null; polling = false;
    if (callId && previous) return previous.api('calls.end',{call_id:callId,device_id:deviceId},{method:'POST'}).catch(() => {});
    return Promise.resolve();
  }
  async function renderHistory(container) {
    if (!hooks || !container) return;
    const epoch = generation;
    container.setAttribute('aria-busy','true');
    try {
      const response = await api('calls.history');
      if (epoch !== generation || !container.isConnected) return;
      container.replaceChildren();
      if (!response.entries?.length) {
        const empty = document.createElement('p'); empty.className = 'pu-call-history-empty'; empty.textContent = tr('historyEmpty'); container.append(empty);
      }
      for (const entry of response.entries || []) {
        const row = document.createElement('div'); row.className = 'pu-call-history-row';
        const icon = document.createElement('span'); icon.className = 'pu-call-history-icon'; icon.innerHTML = svg(entry.kind === 'video' ? 'video' : 'phone');
        const info = document.createElement('div'); info.className = 'pu-call-history-info';
        const name = document.createElement('strong'); name.textContent = entry.peer?.name || 'PingUp';
        const detail = document.createElement('span');
        let status = entry.status === 'active' ? 'connected' : entry.status === 'ringing' ? 'calling' : entry.end_reason === 'timeout' ? 'missed' : entry.end_reason === 'rejected' ? 'rejected' : entry.end_reason === 'cancelled' ? 'cancelled' : 'ended';
        const when = new Date(entry.created_at * 1000).toLocaleString(document.documentElement.lang || undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
        const duration = entry.answered_at && entry.ended_at ? ` · ${Math.floor((entry.ended_at-entry.answered_at)/60)}:${String((entry.ended_at-entry.answered_at)%60).padStart(2,'0')}` : '';
        detail.textContent = `${tr(status)}${duration} · ${when}`;
        info.append(name,detail);
        const direction = document.createElement('span'); direction.className = 'pu-call-history-direction'; direction.innerHTML = svg(entry.incoming ? 'incoming' : 'outgoing');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pu-call-history-redial'; button.innerHTML = svg(entry.kind === 'video' ? 'video' : 'phone');
        button.setAttribute('aria-label',`${tr(entry.kind === 'video' ? 'videoCall' : 'audioCall')} — ${entry.peer?.name || ''}`);
        button.disabled = !entry.peer; button.addEventListener('click',() => start(entry.peer,entry.kind));
        row.append(icon,info,direction,button); container.append(row);
      }
    } catch { if (container.isConnected) { const error = document.createElement('p'); error.textContent = tr('failed'); container.replaceChildren(error); } }
    finally { container.removeAttribute('aria-busy'); }
  }
  document.addEventListener('visibilitychange',() => { if (!document.hidden && hooks) schedule(50); });
  window.addEventListener('pagehide',event => {if(!event.persisted)stop();});
  window.addEventListener('pageshow',()=>{if(hooks)schedule(50);});
  window.addEventListener('online',()=>{if(hooks){schedule(50);if(pc?.connectionState==='disconnected'||pc?.connectionState==='failed')recover();}});
  window.PingUpCalls = Object.freeze({init,start,stop,renderHistory,accept,end,refresh:()=>schedule(50),getStats:mediaStats,getDiagnostics:()=>diagnostics.map(item=>({...item}))});
})();
