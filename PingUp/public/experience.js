/* Notifications, original sounds, outbox and installation. Settings UI lives in settings.js. No private Cache storage. */
(() => {
  "use strict";
  const defaults = {
    sounds: true,
    message_sound: true,
    send_sound: true,
    call_sound: true,
    volume: 0.35,
    dnd: false,
    system: false,
    preview: false,
    scale: "comfortable",
    motion: true,
  };
  let hooks,
    settings = { ...defaults },
    registration,
    userId = null,
    installPrompt = null,
    hasSubscription = false,
    ring = null,
    ringRelease = null,
    ringPending = false,
    callId = null,
    callState = null,
    callNoticeId = null,
    renewTimer = null;
  const tab = crypto.randomUUID?.() || String(Math.random());
  const audio = new Map();
  let unlocked = false;
  const tr = (key) => hooks?.t(key) || key;
  const api = (action, data = {}, post = false) => hooks.api(action, data, post ? { method: "POST" } : {});
  function sound(name, loop = false) {
    if (!unlocked || !settings.sounds || settings.dnd || !userId) return null;
    if (
      ((name === "message" || name === "mention") && !settings.message_sound) ||
      (name === "send" && !settings.send_sound) ||
      (["ringtone", "outgoing"].includes(name) && !settings.call_sound)
    )
      return null;
    let player = audio.get(name);
    if (!player) {
      player = new Audio(new URL("assets/sounds/" + name + ".wav", location.href).href);
      player.preload = "auto";
      audio.set(name, player);
    }
    player.volume = settings.volume;
    player.loop = loop;
    player.currentTime = 0;
    player.play().catch(() => {
      if (loop) {
        ring = null;
        ringPending = false;
        ringRelease?.();
        ringRelease = null;
      }
    });
    return player;
  }
  function stopRingtone() {
    ringPending = false;
    if (ring) {
      ring.pause();
      ring.currentTime = 0;
      ring = null;
    }
    ringRelease?.();
    ringRelease = null;
  }
  function ringtone(name) {
    if (ring || ringPending || settings.dnd || !settings.sounds || !settings.call_sound) return;
    ringPending = true;
    const start = () => {
      if (!ringPending) return;
      ring = sound(name, true);
      if (!ring) ringPending = false;
    };
    if (navigator.locks) {
      navigator.locks
        .request("pingup-ring-" + userId, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            ringPending = false;
            return;
          }
          start();
          if (ring)
            await new Promise((resolve) => {
              ringRelease = resolve;
            });
        })
        .catch(() => {
          ringPending = false;
        });
    } else if (!document.hidden) {
      start();
    } // Older browsers ring in the visible tab only.
  }
  function outboxDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("pingup-private-outbox", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function outboxWork(mode, work) {
    const db = await outboxDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", mode);
      let value;
      try {
        value = work(tx.objectStore("pending"));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(value?.result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  async function queue(message) {
    if (!userId) return;
    // Private pending user input, never API responses/tokens/file bytes, in user-scoped IndexedDB.
    const key = userId + ":" + message.client_id;
    try {
      await outboxWork("readwrite", (store) => store.put({ key, user_id: userId, message: JSON.parse(JSON.stringify(message)) }));
    } catch {
      if (!navigator.onLine) hooks.toast(tr("notify.outbox_unavailable"), "error");
    }
  }
  async function ack(clientId) {
    if (!userId || !clientId) return;
    try {
      await outboxWork("readwrite", (store) => store.delete(userId + ":" + clientId));
    } catch {}
  }
  async function clearOutbox(id) {
    try {
      await outboxWork("readwrite", (store) => {
        const r = store.openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (c) {
            if (c.value.user_id === id) c.delete();
            c.continue();
          }
        };
        return r;
      });
    } catch {}
  }
  async function restoreOutbox() {
    try {
      const rows = await outboxWork("readonly", (store) => store.getAll());
      for (const row of rows || [])
        if (row.user_id === userId && hooks.hasChat(Number(row.message.conversation_id))) hooks.restoreQueued(row.message);
      if (navigator.onLine) hooks.retryQueued();
    } catch {}
  }
  function apply() {
    document.documentElement.dataset.motion = settings.motion ? "on" : "off";
    document.documentElement.dataset.uiScale = settings.scale;
    document.documentElement.style.setProperty(
      "--ui-factor",
      { compact: 0.9, standard: 1, comfortable: 1.1, large: 1.25 }[settings.scale] || 1.1,
    );
    for (const player of audio.values()) player.volume = settings.volume;
    if (settings.dnd || !settings.sounds || !settings.call_sound) stopRingtone();
  }
  async function save(patch) {
    settings = await api("notifications.settings", patch, true);
    apply();
    hooks.onSettings?.(settings);
    mount();
    return settings;
  }
  function workerMessage(data) {
    const worker = registration?.active || navigator.serviceWorker?.controller;
    if (worker) worker.postMessage(data);
  }
  async function register() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      registration = await navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) updateNotice();
        });
      });
      await navigator.serviceWorker.ready;
      workerMessage({ type: "bind", user_id: userId });
      hasSubscription = !!(await registration.pushManager.getSubscription());
      await renew();
      mount();
      if (registration.waiting) updateNotice();
    } catch {
      hooks?.toast(tr("pwa.register_failed"), "error");
    }
  }
  function updateNotice() {
    let button = document.querySelector("#pwa-update");
    if (button) return;
    button = document.createElement("button");
    button.id = "pwa-update";
    button.className = "pwa-update secondary-button";
    button.textContent = tr("pwa.update");
    button.onclick = () => {
      if (callId) {
        hooks.toast(tr("pwa.update_after_call"));
        return;
      }
      registration.waiting?.postMessage({ type: "activate-update" });
    };
    document.body.append(button);
  }
  async function enablePush() {
    if (!window.isSecureContext || !("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
      hooks.toast(tr("notify.unsupported"), "error");
      return;
    }
    const permission = await Notification.requestPermission(); // Called only from the Enable button.
    if (permission !== "granted") {
      hooks.toast(tr("settings.notifications_denied"), "error");
      return;
    }
    try {
      if (!registration) await register();
      const info = await api("push.status");
      if (!info.enabled) {
        hooks.toast(tr("notify.not_configured"), "error");
        return;
      }
      const publicBytes = Uint8Array.from(atob(info.public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      let sub = await registration.pushManager.getSubscription();
      if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicBytes });
      await api("push.subscribe", sub.toJSON(), true);
      hasSubscription = true;
      await save({ system: true });
      workerMessage({ type: "bind", user_id: userId });
      hooks.toast(tr("notify.enabled"), "success");
    } catch {
      hooks.toast(tr("notify.enable_failed"), "error");
    }
  }
  async function disablePush(clearBinding = false) {
    hasSubscription = false;
    if (clearBinding) await clearOutbox(userId);
    try {
      const sub = await registration?.pushManager.getSubscription();
      if (sub) {
        await api("push.unsubscribe", { endpoint: sub.endpoint }, true);
        await sub.unsubscribe();
      }
    } catch {}
    if (clearBinding) {
      workerMessage({ type: "bind", user_id: null });
      workerMessage({ type: "close-notifications", all: true });
    } else await save({ system: false });
  }
  async function renew() {
    if (!userId || !registration || !settings.system || Notification.permission !== "granted") return;
    try {
      const sub = await registration.pushManager.getSubscription();
      if (sub) await api("push.subscribe", sub.toJSON(), true);
    } catch {}
  }
  function mount() {
    const update = document.querySelector("#pwa-update");
    if (update) update.textContent = tr("pwa.update");
  }
  async function claim(event) {
    // Serialize a localStorage high-water mark across tabs when Web Locks is supported.
    const work = () => {
      const key = `pingup.seen.${userId}`;
      let seen = [];
      try {
        seen = JSON.parse(localStorage.getItem(key) || "[]");
      } catch {}
      if (seen.includes(event.event_id)) return false;
      seen.push(event.event_id);
      try {
        localStorage.setItem(key, JSON.stringify(seen.slice(-500)));
      } catch {}
      return true;
    };
    return navigator.locks ? navigator.locks.request("pingup-notification-" + userId, work) : work();
  }
  function inAppNotice(event) {
    const button = document.createElement("button");
    button.className = "toast message-notification";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = event.title;
    const body = document.createElement("small");
    body.textContent = event.body;
    text.append(title, body);
    button.append(text);
    button.onclick = () => {
      if (event.kind === "feedback") hooks.openFeedback?.(event.ticket_id);
      else if (event.kind === "contact") hooks.openContacts?.();
      else hooks.openChat(event.conversation_id);
      button.remove();
    };
    const host = document.querySelector("#toasts");
    host.append(button);
    while (host.children.length > 4) host.firstElementChild.remove();
    setTimeout(() => {
      button.classList.add("leaving");
      setTimeout(() => button.remove(), 220);
    }, 6000);
  }
  async function events(list) {
    for (const event of list || []) {
      if (settings.dnd || event.kind === "call") continue;
      if (event.conversation_id && hooks.activeChat() === event.conversation_id && document.hasFocus() && !document.hidden) continue;
      if (!(await claim(event))) continue;
      if (!document.hidden && document.hasFocus()) {
        inAppNotice(event);
        sound(event.kind === "mention" ? "mention" : "message");
      } else if (settings.system && Notification.permission === "granted") {
        workerMessage({ type: "notify", event_id: event.event_id, user_id: userId });
      }
    }
  }
  async function openURL(raw) {
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    const invite = url.searchParams.get("invite");
    if (invite && hooks?.joinInvite) {
      await hooks.joinInvite(invite);
      url.searchParams.delete("invite");
      history.replaceState(null, "", url.href);
    }
    const feedback = Number(url.searchParams.get("feedback"));
    if (Number.isSafeInteger(feedback) && feedback > 0) hooks?.openFeedback?.(feedback);
    if (url.searchParams.has("contacts")) hooks?.openContacts?.();
    const chat = Number(url.searchParams.get("chat"));
    if (Number.isSafeInteger(chat) && chat > 0 && hooks?.hasChat(chat)) await hooks.openChat(chat);
    if (url.searchParams.has("call")) {
      hooks?.refreshCalls();
      if (url.searchParams.get("answer") === "1") hooks?.toast(tr("notify.answer_in_app"));
    }
  }
  function call(call) {
    if (callId !== call.id) {
      stopRingtone();
      callId = call.id;
      callState = null;
    }
    if (callState !== call.status) {
      stopRingtone();
      callState = call.status;
    }
    if (call.status === "ringing") ringtone(call.incoming ? "ringtone" : "outgoing");
    if (
      callNoticeId !== call.id &&
      call.incoming &&
      call.status === "ringing" &&
      settings.system &&
      (document.hidden || !document.hasFocus()) &&
      call.notification_event_id
    ) {
      callNoticeId = call.id;
      workerMessage({ type: "notify", event_id: call.notification_event_id, user_id: userId });
    }
  }
  function callEnd() {
    const hadCall = !!callId;
    workerMessage({ type: "close-notifications", call_id: callId });
    stopRingtone();
    callId = null;
    callState = null;
    callNoticeId = null;
    if (hadCall) sound("end");
  }
  function callConnected() {
    workerMessage({ type: "close-notifications", call_id: callId });
    stopRingtone();
    callState = "active";
  }
  async function init(data) {
    userId = data.user?.id || null;
    settings = { ...defaults, ...data.notification_settings };
    apply();
    hooks.onSettings?.(settings);
    workerMessage({ type: "bind", user_id: userId });
    clearInterval(renewTimer);
    if (userId) {
      renew();
      renewTimer = setInterval(renew, 3600000);
      await restoreOutbox();
      openURL(location.href);
    }
  }
  function stop() {
    callEnd();
    clearInterval(renewTimer);
    userId = null;
    workerMessage({ type: "bind", user_id: null });
    workerMessage({ type: "close-notifications", all: true });
    for (const player of audio.values()) player.pause();
  }
  document.addEventListener(
    "pointerdown",
    () => {
      unlocked = true;
      if (callId && callState === "ringing") ringtone("ringtone");
    },
    { passive: true },
  );
  document.addEventListener(
    "keydown",
    () => {
      unlocked = true;
    },
    { passive: true },
  );
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || !hooks || !button.hasAttribute("data-install-pingup")) return;
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    } else hooks.toast(tr("pwa.install_hint"));
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    mount();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    mount();
  });
  window.addEventListener("online", () => {
    hooks?.reconnect();
    renew();
    registration?.update();
  });
  window.addEventListener("offline", () => hooks?.offline());
  window.addEventListener("pageshow", () => hooks?.reconnect());
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-notification") openURL(event.data.url);
      if (event.data?.type === "notification-event") hooks?.reconnect();
      if (event.data?.type === "subscription-changed") hooks?.toast(tr("notify.resubscribe"));
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (document.querySelector("#pwa-update") && !callId) location.reload();
    });
  }
  window.PingUpExperience = Object.freeze({
    configure(options) {
      hooks = options;
      register();
    },
    init,
    stop,
    mount,
    events,
    sound,
    queue,
    ack,
    call,
    callEnd,
    callConnected,
    enablePush,
    disablePush,
    save,
    updateSettings(value) {
      settings = { ...defaults, ...value };
      apply();
      hooks?.onSettings?.(settings);
    },
    chatRead(id) {
      workerMessage({ type: "close-notifications", conversation_id: id });
    },
  });
})();
