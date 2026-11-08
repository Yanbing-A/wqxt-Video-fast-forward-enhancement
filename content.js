/* 问渠播放增强：→/← 短按快进/快退 5 秒，长按 → 临时加速，↑/↓ 调速。 */
(() => {
  'use strict';

  if (window.__WQXT_PLAYER_ENHANCE__) return;
  window.__WQXT_PLAYER_ENHANCE__ = true;

  const CONFIG = {
    seekStep: 5,
    holdDelay: 100,
    fastRate: 2.0,
    rateStep: 0.25,
    minRate: 0.5,
    maxRate: 4.0
  };

  const HOLD_DELAY_KEY = 'wqxt-player-hold-delay-v1';
  const DEFAULT_HOLD_DELAY = 100;
  const MIN_HOLD_DELAY = 10;
  const MAX_HOLD_DELAY = 500;
  const HOLD_SYNC_TAG = 'wqxt-player-enhance/v1';
  const HOLD_SYNC_REQUEST = 'hold-delay-request';
  const HOLD_SYNC_MESSAGE = 'hold-delay-sync';
  const HOLD_SYNC_WAIT_MS = 200;

  // 两个速度分开保存，互不覆盖：
  // base = 玩家在播放器里设置的基础速度（例 1.5×）
  // boost = 长按 → 时使用的加速速度（例 2.5×）
  const BASE_STORAGE_KEY = 'wqxt-player-base-rate-v2';
  const BOOST_STORAGE_KEY = 'wqxt-player-boost-rate-v2';
  // v1.4 之前可能把错误值 0.5 写进旧 key；只迁移非 0.5 的旧数据。
  const LEGACY_BASE_KEY = 'wqxt-player-base-rate';
  const LEGACY_BOOST_KEY = 'wqxt-player-boost-rate';

  let activeVideo = null;
  let longVideo = null;
  let longMode = false;
  let rightDown = false;
  let holdTimer = 0;
  let holdTimerStartedAt = 0;
  let holdDelaySynced = false;
  let pressStartedAt = 0;
  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch (error) {
      return false;
    }
  })();
  let rateGuardTimer = 0;
  let originalRate = 1;
  let longRate = CONFIG.fastRate;
  let boostRate = CONFIG.fastRate;

  let savedRate = null;
  let storageReady = false;
  let autoApplyPending = true;
  let userTouched = false;
  let pendingRate = null;
  let saveTimer = 0;
  const readyVideos = new WeakSet();
  const playedVideos = new WeakSet();

  // 全屏复杂页面里反复全 DOM 遍历会让 100ms 计时器被拖到 1s 甚至更久，
  // 所以把 video 列表缓存起来，只在必要时刷新。
  let videosCache = [];
  let videosCacheAt = 0;

  let host = null;
  let hud = null;
  let hudTimer = 0;
  let hudRaf = 0;
  let hudLastPosition = 0;
  let blurTimer = 0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function keyName(event) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' ||
        event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      return event.key;
    }
    return {
      37: 'ArrowLeft',
      38: 'ArrowUp',
      39: 'ArrowRight',
      40: 'ArrowDown'
    }[event.keyCode] || '';
  }

  function isTyping(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some((node) => {
      if (!(node instanceof Element)) return false;
      if (node.matches('input, textarea, select, [role="textbox"]')) return true;
      if (node.matches('[contenteditable]:not([contenteditable="false"])')) return true;
      return false;
    });
  }

  function consume(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function isFullscreenVideo(video) {
    const fullscreen = document.fullscreenElement;
    if (!fullscreen || !video) return false;
    if (fullscreen === video || fullscreen.contains(video)) return true;

    // video 可能在一个 shadow root 里；沿 host 链检查它是否属于全屏容器。
    let root = typeof video.getRootNode === 'function' ? video.getRootNode() : null;
    while (root && root.host) {
      if (fullscreen === root.host || fullscreen.contains(root.host)) return true;
      root = typeof root.host.getRootNode === 'function' ? root.host.getRootNode() : null;
    }
    return false;
  }

  function visibleArea(video) {
    if (!video || !video.isConnected) return 0;

    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden') return 0;

    // 原生视频全屏时，浏览器可能把元素布局尺寸报成 0；
    // 只要它属于当前全屏容器，就视为可见，否则全屏下会时灵时不灵。
    if (isFullscreenVideo(video)) {
      const rect = video.getBoundingClientRect();
      if (rect.width >= 2 && rect.height >= 2) return rect.width * rect.height;
      return 1e9;
    }

    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      // 刚点全屏、播放器还在 resize 时，video 的布局尺寸可能短暂为 0，
      // 但它其实已经在播放。此时按“正在播放且有分辨率”认它，
      // 否则 100ms/500ms 的计时会白等，表现成延迟不按设置来。
      if (!video.paused && video.readyState >= 2 &&
          video.videoWidth >= 2 && video.videoHeight >= 2) {
        return video.videoWidth * video.videoHeight;
      }
      return 0;
    }
    return rect.width * rect.height;
  }

  function collectVideos(root, result) {
    if (!root || !root.querySelectorAll) return result;
    root.querySelectorAll('video').forEach((video) => result.push(video));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) collectVideos(node.shadowRoot, result);
    }
    return result;
  }

  function invalidateVideos() {
    videosCacheAt = 0;
  }

  function allVideos() {
    const now = Date.now();
    if (videosCacheAt && now - videosCacheAt < 250) return videosCache;
    videosCache = Array.from(new Set(collectVideos(document, [])));
    videosCacheAt = now;
    return videosCache;
  }

  function pickVideo() {
    if (activeVideo && visibleArea(activeVideo) > 0) return activeVideo;

    const videos = allVideos().filter((video) => visibleArea(video) > 0);
    videos.sort((a, b) => {
      const playingA = a.paused ? 0 : 1;
      const playingB = b.paused ? 0 : 1;
      if (playingA !== playingB) return playingB - playingA;
      return visibleArea(b) - visibleArea(a);
    });

    activeVideo = videos[0] || null;
    return activeVideo;
  }

  function formatRate(rate) {
    const value = Math.round(rate * 100) / 100;
    return Number.isInteger(value) ? value.toFixed(1) : String(value);
  }

  function setRate(video, rate) {
    if (!video) return;
    try {
      video.playbackRate = clamp(Number(rate), CONFIG.minRate, CONFIG.maxRate);
    } catch (error) {
      // 某些流媒体在切换清晰度时会短暂禁止改 rate，忽略即可。
    }
  }

  function stopRateGuard() {
    if (rateGuardTimer) {
      clearInterval(rateGuardTimer);
      rateGuardTimer = 0;
    }
  }

  // 平台播放器有时会在 timeupdate/切清晰度时把 playbackRate 重置回 1×。
  // 长按期间持续校正，避免“有时候能加速、有时候又变回原速”。
  function enforceLongRate() {
    if (!longMode) {
      stopRateGuard();
      return;
    }

    const video = longVideo && longVideo.isConnected && visibleArea(longVideo) > 0
      ? longVideo
      : (pickVideo() || activeVideo || null);
    if (!video) return;
    longVideo = video;

    if (!Number.isFinite(video.playbackRate) ||
        Math.abs(video.playbackRate - longRate) > 0.01) {
      setRate(video, longRate);
    }
  }

  function startRateGuard() {
    stopRateGuard();
    rateGuardTimer = setInterval(enforceLongRate, 60);
  }

  function stopHudLoop() {
    if (hudRaf) {
      cancelAnimationFrame(hudRaf);
      hudRaf = 0;
    }
  }

  function positionHud() {
    if (!hud) return;

    const width = hud.offsetWidth || 180;
    const height = hud.offsetHeight || 42;
    const video = (longMode && longVideo) || pickVideo() || activeVideo;
    const margin = 12;

    let left;
    let top;

    if (video && video.isConnected) {
      const rect = video.getBoundingClientRect();
      left = rect.right - width - margin;
      top = rect.top + margin;
    } else {
      left = window.innerWidth - width - margin;
      top = margin;
    }

    left = clamp(left, 8, Math.max(8, window.innerWidth - width - 8));
    top = clamp(top, 8, Math.max(8, window.innerHeight - height - 8));

    hud.style.left = `${Math.round(left)}px`;
    hud.style.top = `${Math.round(top)}px`;
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
  }

  function hudLoop(ts) {
    hudRaf = 0;
    if (!hud || !hud.classList.contains('show')) return;
    if (!hudLastPosition || !ts || ts - hudLastPosition > 120) {
      positionHud();
      hudLastPosition = ts || 0;
    }
    if (typeof requestAnimationFrame === 'function') {
      hudRaf = requestAnimationFrame(hudLoop);
    }
  }

  function ensureHost() {
    if (host && host.isConnected) {
      mountHost();
      return;
    }

    host = document.createElement('div');
    host.id = 'wqxt-player-enhance-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .hud {
          position: fixed;
          top: 12px;
          left: 12px;
          padding: 5px 9px;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 8px;
          background: rgba(16,18,24,.86);
          box-shadow: 0 8px 22px rgba(0,0,0,.32);
          color: #fff;
          font: 700 13px/1.3 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          visibility: hidden;
          transform: translateY(-4px);
          transition: opacity .12s ease, transform .12s ease, visibility .12s ease;
          backdrop-filter: blur(8px);
        }
        .hud.show {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
        }
      </style>
      <div class="hud"></div>
    `;

    hud = shadow.querySelector('.hud');

    const parent = document.documentElement || document.body;
    if (parent) parent.appendChild(host);
    mountHost();
  }

  function mountHost() {
    if (!host) return;

    const fullscreen = document.fullscreenElement;
    if (fullscreen && fullscreen.tagName !== 'VIDEO') {
      host.style.display = '';
      if (host.parentNode !== fullscreen) fullscreen.appendChild(host);
      return;
    }

    host.style.display = fullscreen ? 'none' : '';
    const parent = document.documentElement || document.body;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  function hideHud() {
    clearTimeout(hudTimer);
    hudTimer = 0;
    stopHudLoop();
    if (hud) hud.classList.remove('show');
  }

  function showHud(text, duration = 900) {
    ensureHost();
    if (!hud) return;

    hud.textContent = text;
    hud.classList.add('show');
    positionHud();

    clearTimeout(hudTimer);
    hudTimer = 0;
    if (!hudRaf && typeof requestAnimationFrame === 'function') {
      hudRaf = requestAnimationFrame(hudLoop);
    }

    if (duration > 0) {
      hudTimer = setTimeout(() => {
        if (hud) hud.classList.remove('show');
        stopHudLoop();
      }, duration);
    }
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function readLocalNumber(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined || raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? clamp(value, CONFIG.minRate, CONFIG.maxRate) : null;
    } catch (error) {
      return null;
    }
  }

  function writeLocalNumber(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      // 隐私模式/禁用本地存储时忽略，chrome.storage 仍然可用。
    }
  }

  function normaliseHoldDelay(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(clamp(value, MIN_HOLD_DELAY, MAX_HOLD_DELAY));
  }

  function readLocalHoldDelay() {
    try {
      return normaliseHoldDelay(window.localStorage.getItem(HOLD_DELAY_KEY));
    } catch (error) {
      return null;
    }
  }

  function writeLocalHoldDelay(value) {
    try {
      window.localStorage.setItem(HOLD_DELAY_KEY, String(value));
    } catch (error) {
      // 隐私模式可能禁用 localStorage；chrome.storage 仍然是主存储。
    }
  }

  function currentHoldDelay() {
    // localStorage 只用于冷启动兜底。一旦本实例从 chrome.storage / 上层 frame
    // 同步过，就以 CONFIG.holdDelay 为准：全屏可能重建播放器文档/iframe，
    // 新 frame 自己的 localStorage 可能是空的或跨域独立的，不能反过来
    // 把已经同步好的设置值覆盖回默认 100ms。
    if (!holdDelaySynced) {
      const local = readLocalHoldDelay();
      if (local !== null) CONFIG.holdDelay = local;
    }
    return CONFIG.holdDelay;
  }

  // 从按下时刻起算剩余时间重排计时器：设置值在按住期间才同步到位时，
  // 不会让旧的 100ms 计时器抢先触发。
  function scheduleHoldFromPress() {
    if (!rightDown || longMode || !holdTimerStartedAt) return;
    const remaining = Math.max(0, currentHoldDelay() - (Date.now() - holdTimerStartedAt));
    clearTimeout(holdTimer);
    holdTimer = setTimeout(tryEnterLongMode, remaining);
  }

  function isChildFrame(source) {
    try {
      for (let i = 0; i < window.frames.length; i += 1) {
        if (window.frames[i] === source) return true;
      }
    } catch (error) {
      // 跨域 frames 读取受限时忽略。
    }
    return false;
  }

  // 顶层向所有子 frame 广播；子 frame 收到后继续往下广播，形成递归同步。
  // postMessage 用 '*' 才能穿透跨域播放器 iframe。
  function broadcastHoldDelay(value) {
    const payload = { tag: HOLD_SYNC_TAG, type: HOLD_SYNC_MESSAGE, value };
    try {
      for (let i = 0; i < window.frames.length; i += 1) {
        try {
          window.frames[i].postMessage(payload, '*');
        } catch (error) {
          // 单个 frame 拒绝时不影响其它 frame。
        }
      }
    } catch (error) {
      // 没有子 frame 时忽略。
    }
  }

  function applyHoldDelay(value, broadcast) {
    const safe = normaliseHoldDelay(value);
    if (safe === null) return;
    CONFIG.holdDelay = safe;
    holdDelaySynced = true;
    writeLocalHoldDelay(safe);
    scheduleHoldFromPress();
    if (broadcast) broadcastHoldDelay(safe);
  }

  function refreshHoldDelay() {
    if (!hasStorage() || typeof chrome.storage.local.get !== 'function') {
      broadcastHoldDelay(CONFIG.holdDelay);
      return;
    }
    try {
      chrome.storage.local.get({ [HOLD_DELAY_KEY]: null }, (result) => {
        const value = normaliseHoldDelay(result && result[HOLD_DELAY_KEY]);
        if (value !== null) {
          applyHoldDelay(value, true);
        } else {
          // 从未设置过：默认 100ms 就是权威值，标记已同步，
          // 免得首次长按还要多等一轮冷启动宽限期。
          holdDelaySynced = true;
          broadcastHoldDelay(CONFIG.holdDelay);
        }
      });
    } catch (error) {
      // 扩展上下文暂时不可用时使用本地缓存/默认值。
      broadcastHoldDelay(CONFIG.holdDelay);
    }
  }

  function loadHoldDelay() {
    const local = readLocalHoldDelay();
    if (local !== null) CONFIG.holdDelay = local;
    refreshHoldDelay();
  }

  // 冷启动的新 frame 还没拿到权威值时，先别按默认 100ms 抢跑；
  // 等同步完成后再从「按下的那一刻」起算剩余延迟。
  function waitForHoldDelay(deadline, requested) {
    if (!rightDown || longMode) return;
    if (holdDelaySynced || Date.now() >= deadline) {
      scheduleHoldFromPress();
      return;
    }
    if (!requested) refreshHoldDelay();
    holdTimer = setTimeout(() => waitForHoldDelay(deadline, true), 16);
  }

  function watchHoldDelay() {
    if (!hasStorage() || !chrome.storage.onChanged) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[HOLD_DELAY_KEY]) return;
        const value = normaliseHoldDelay(changes[HOLD_DELAY_KEY].newValue);
        if (value !== null) applyHoldDelay(value, true);
      });
    } catch (error) {
      // 忽略监听注册失败，仍使用当前的 CONFIG.holdDelay。
    }
  }

  function flushRate() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (pendingRate === null) return;

    const value = pendingRate;
    pendingRate = null;
    writeLocalNumber(BASE_STORAGE_KEY, value);
    if (!hasStorage()) return;

    try {
      chrome.storage.local.set({ [BASE_STORAGE_KEY]: value });
    } catch (error) {
      // 扩展被重新加载时可能暂时不可用，忽略即可。
    }
  }

  function saveBaseRate(rate) {
    const value = clamp(Number(rate), CONFIG.minRate, CONFIG.maxRate);
    if (!Number.isFinite(value)) return;

    savedRate = value;
    pendingRate = value;
    writeLocalNumber(BASE_STORAGE_KEY, value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushRate, 150);
  }

  function saveBoostRate(rate) {
    const value = clamp(Number(rate), CONFIG.minRate, CONFIG.maxRate);
    if (!Number.isFinite(value)) return;

    boostRate = value;
    writeLocalNumber(BOOST_STORAGE_KEY, value);
    if (!hasStorage()) return;

    try {
      chrome.storage.local.set({ [BOOST_STORAGE_KEY]: value });
    } catch (error) {
      // 扩展被重新加载时可能暂时不可用，忽略即可。
    }
  }

  function captureBaseRate() {
    let rate = savedRate;

    if (longMode) {
      rate = originalRate;
    } else {
      const video = pickVideo() || activeVideo;
      if (video && Number.isFinite(video.playbackRate) && video.playbackRate > 0) {
        rate = video.playbackRate;
      }
    }

    if (rate !== null && rate !== undefined) saveBaseRate(rate);
  }

  function applySavedRate() {
    if (!autoApplyPending || !storageReady || savedRate === null || longMode || userTouched) return;

    const video = pickVideo();
    if (!video) return;

    // 每个页面只在视频第一次就绪时恢复一次。快进会触发 emptied/canplay，
    // 之前在这里反复应用会把用户正在使用的速度覆盖回旧值。
    autoApplyPending = false;

    const target = clamp(savedRate, CONFIG.minRate, CONFIG.maxRate);
    if (Math.abs(video.playbackRate - target) < 0.01) return;

    setRate(video, target);
  }

  function legacyLocalRate(key) {
    const value = readLocalNumber(key);
    // 旧版本没有值时会把它算成 0.5，这不是用户主动设置的速度。
    return value === null || Math.abs(value - 0.5) < 0.01 ? null : value;
  }

  function loadSavedRate() {
    const localBase = readLocalNumber(BASE_STORAGE_KEY) ?? legacyLocalRate(LEGACY_BASE_KEY);
    const localBoost = readLocalNumber(BOOST_STORAGE_KEY) ?? legacyLocalRate(LEGACY_BOOST_KEY);
    if (localBase !== null) savedRate = localBase;
    if (localBoost !== null) boostRate = localBoost;

    if (!hasStorage()) {
      storageReady = true;
      applySavedRate();
      return;
    }

    try {
      const keys = {
        [BASE_STORAGE_KEY]: null,
        [BOOST_STORAGE_KEY]: null,
        [LEGACY_BASE_KEY]: null,
        [LEGACY_BOOST_KEY]: null
      };
      chrome.storage.local.get(keys, (result) => {
        // 不能直接 Number(null)：Number(null) === 0，会被 clamp 成 0.5。
        const toRate = (raw) => {
          if (raw === null || raw === undefined || raw === '') return null;
          const value = Number(raw);
          return Number.isFinite(value) ? clamp(value, CONFIG.minRate, CONFIG.maxRate) : null;
        };
        const ignoreLegacyHalf = (value) => (
          value !== null && Math.abs(value - 0.5) < 0.01 ? null : value
        );
        const base = toRate(result && result[BASE_STORAGE_KEY])
          ?? ignoreLegacyHalf(toRate(result && result[LEGACY_BASE_KEY]))
          ?? localBase;
        const boost = toRate(result && result[BOOST_STORAGE_KEY])
          ?? ignoreLegacyHalf(toRate(result && result[LEGACY_BOOST_KEY]))
          ?? localBoost;

        if (base !== null) savedRate = base;
        if (boost !== null) boostRate = boost;

        storageReady = true;
        applySavedRate();
      });
    } catch (error) {
      storageReady = true;
      applySavedRate();
    }
  }

  function onVideoReady(event) {
    const video = event.target;
    if (!video || video.tagName !== 'VIDEO') return;

    invalidateVideos();
    activeVideo = video;
    if (event.type === 'emptied' || event.type === 'loadstart') {
      readyVideos.delete(video);
      playedVideos.delete(video);
      return;
    }

    if (event.type === 'play') {
      if (playedVideos.has(video)) return;
      playedVideos.add(video);
      setTimeout(() => {
        if (!longMode) applySavedRate();
      }, 220);
      return;
    }

    if (readyVideos.has(video)) return;
    readyVideos.add(video);
    setTimeout(() => {
      if (!longMode) applySavedRate();
    }, 80);
  }

  function seekBy(delta) {
    const video = pickVideo();
    if (!video) return;

    const oldTime = Number(video.currentTime) || 0;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    let target = oldTime + delta;

    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
    target = Math.max(0, target);

    if (Math.abs(target - oldTime) < 0.01) return;

    try {
      video.currentTime = target;
    } catch (error) {
      return;
    }

    const actual = Math.abs(target - oldTime).toFixed(1).replace(/\.0$/, '');
    showHud(`${delta > 0 ? '快进' : '快退'} ${actual} 秒`, 750);
  }

  function enterLongMode() {
    // 全屏/播放器 resize 时 pickVideo 可能暂时挑不到视频；用上一次的
    // activeVideo 兜底，让长按“到点就进入加速”，而不是每 16ms 重试、
    // 拖到视频稳定后才进入，避免全屏前后触发延迟不一致。
    const video = pickVideo() || activeVideo || null;
    if (!video) return false;

    userTouched = true;
    longVideo = video;
    originalRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0
      ? video.playbackRate
      : 1;
    // 上次用 ↑/↓ 设置的加速速度会在这里继续使用。
    longRate = clamp(Math.max(boostRate, originalRate), CONFIG.minRate, CONFIG.maxRate);
    longMode = true;
    saveBaseRate(originalRate);
    setRate(longVideo, longRate);
    startRateGuard();
    showHud(`${formatRate(longRate)}×`, 0);
    return true;
  }

  function exitLongMode(silent) {
    longMode = false;
    stopRateGuard();
    const video = longVideo && longVideo.isConnected ? longVideo : pickVideo();
    const restoreRate = originalRate;
    if (video) {
      setRate(video, restoreRate);
      // 有些播放器会在按键抬起后紧接着再改一次 rate，补一次恢复。
      setTimeout(() => {
        if (!longMode && video.isConnected) setRate(video, restoreRate);
      }, 60);
    }
    longVideo = null;

    hideHud();
  }

  function adjustRate(delta) {
    if (!longMode) return;

    const floor = Math.max(CONFIG.minRate, originalRate);
    longRate = clamp(longRate + delta, floor, CONFIG.maxRate);
    boostRate = longRate;
    const video = longVideo && longVideo.isConnected ? longVideo : pickVideo();
    if (video) {
      longVideo = video;
      setRate(video, longRate);
    }
    startRateGuard();
    // ↑/↓ 设置的是“以后长按 → 时使用的加速速度”，长期保存；
    // 但松开 → 仍然恢复播放器原本的基础速度。
    saveBoostRate(longRate);
    showHud(`${formatRate(longRate)}×`, 0);
  }

  function tryEnterLongMode() {
    if (!rightDown || longMode) return;
    if (enterLongMode()) return;

    // 按下瞬间视频可能还没渲染出来；只要还按着就继续尝试，
    // 避免“有时能长按、有时没反应”。松开时 onKeyUp 会清掉重试。
    holdTimer = setTimeout(tryEnterLongMode, 16);
  }

  function abortHold(silent) {
    rightDown = false;
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (longMode) exitLongMode(silent);
  }

  function onKeyDown(event) {
    if (event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event)) return;

    const key = keyName(event);
    if (!key) return;

    if (key === 'ArrowRight') {
      // 系统按键重复很密集。先消费掉，避免平台自己快进；
      // 但不要每次 repeat 都全 DOM 找 video，否则全屏复杂页面会卡住计时器。
      if (event.repeat) {
        consume(event);
        return;
      }

      if (!allVideos().length && !activeVideo) return;
      consume(event);

      // 如果上一次 keyup 丢失、longMode 还挂着，先静默结束；
      // 否则新的一次长按会被旧的加速状态挡住。
      if (longMode) exitLongMode(true);

      // 不因为上一次的 rightDown 残留而吞掉新的长按；每次按下都重新计时。
      rightDown = true;
      pressStartedAt = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
      holdTimerStartedAt = Date.now();
      clearTimeout(holdTimer);
      if (!holdDelaySynced) {
        // 全屏重建出来的 frame 可能还没等到 chrome.storage 回调；
        // 等权威值到了再按设置值计时，避免一进全屏就退回默认 100ms。
        holdTimer = setTimeout(
          () => waitForHoldDelay(holdTimerStartedAt + HOLD_SYNC_WAIT_MS),
          0
        );
      } else {
        scheduleHoldFromPress();
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (!pickVideo()) return;
      consume(event);
      if (event.repeat || longMode) return;
      seekBy(-CONFIG.seekStep);
      return;
    }

    if (!longMode) return;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      consume(event);
      adjustRate(key === 'ArrowUp' ? CONFIG.rateStep : -CONFIG.rateStep);
    }
  }

  function onKeyUp(event) {
    if (keyName(event) !== 'ArrowRight') return;
    // longMode 还在但 rightDown 已经丢了，也要允许 keyup 把它收尾。
    if (!rightDown && !longMode) return;

    // 全屏下 keyup 可能比下一次 keydown 晚到。迟到的旧 keyup
    // 不能把新一次长按的计时器清掉，否则第二次会明显变长/没反应。
    if (pressStartedAt && Number.isFinite(event.timeStamp) &&
        event.timeStamp < pressStartedAt) {
      return;
    }

    consume(event);
    rightDown = false;
    pressStartedAt = 0;
    clearTimeout(holdTimer);
    holdTimer = 0;

    if (longMode) {
      exitLongMode(false);
    } else {
      seekBy(CONFIG.seekStep);
    }
  }

  // 跨 frame 配置同步：全屏播放器常在 iframe 里，顶层刷新了设置后
  // 子 frame 的 content script 不一定拿得到；用 postMessage 主动对齐。
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.tag !== HOLD_SYNC_TAG) return;

    if (data.type === HOLD_SYNC_REQUEST) {
      if (event.source) {
        try {
          event.source.postMessage(
            { tag: HOLD_SYNC_TAG, type: HOLD_SYNC_MESSAGE, value: currentHoldDelay() },
            '*'
          );
        } catch (error) {
          // frame 已销毁，忽略。
        }
      }
      refreshHoldDelay();
      return;
    }

    if (data.type === HOLD_SYNC_MESSAGE) {
      // 只接受来自父/子 frame 的消息，避免页面脚本伪造配置。
      if (event.source === window ||
          (event.source !== window.parent && !isChildFrame(event.source))) return;
      applyHoldDelay(data.value, true);
    }
  });

  document.addEventListener('pointerdown', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const video = path.find((node) => node && node.tagName === 'VIDEO');
    if (video) activeVideo = video;
  }, true);

  document.addEventListener('ratechange', (event) => {
    if (!longMode) return;
    const video = event.target;
    if (!video || video.tagName !== 'VIDEO') return;
    if (Math.abs(video.playbackRate - longRate) > 0.01) {
      longVideo = video;
      setRate(video, longRate);
    }
  }, true);
  document.addEventListener('loadedmetadata', onVideoReady, true);
  document.addEventListener('canplay', onVideoReady, true);
  document.addEventListener('play', onVideoReady, true);
  document.addEventListener('loadstart', onVideoReady, true);
  document.addEventListener('emptied', onVideoReady, true);
  document.addEventListener('fullscreenchange', () => {
    // 保留 activeVideo 作为兜底：全屏瞬间 pickVideo 可能暂时挑不到视频，
    // enterLongMode 需要它才能按设置好的延迟准时进入加速。
    invalidateVideos();
    mountHost();
    positionHud();
    // 全屏可能重建播放器文档/iframe：立刻重新拉一次权威设置并广播，
    // 否则新 frame 会先用默认 100ms 跑，表现为自定义延迟在全屏后失效。
    refreshHoldDelay();
    // 只在已经拿到权威值时立刻广播，避免把还没校准的默认 100ms 扩散出去。
    if (isTopFrame && holdDelaySynced) broadcastHoldDelay(CONFIG.holdDelay);
  }, true);
  window.addEventListener('resize', positionHud);
  window.addEventListener('scroll', positionHud, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => {
    clearTimeout(blurTimer);
    // 原生视频全屏时浏览器把焦点交给原生控件，document.hasFocus() 常为 false，
    // 固定 220ms 的宽限期又短于用户自定义的触发延迟，会直接把长按计时掐掉。
    // 全屏期间不按失焦中止；真正切走窗口仍有 visibilitychange/pagehide 兜底。
    if (document.fullscreenElement) return;
    const grace = Math.max(220, currentHoldDelay() + 150);
    blurTimer = setTimeout(() => {
      if (!document.fullscreenElement && !document.hasFocus()) {
        abortHold(true);
        captureBaseRate();
      }
    }, grace);
  });
  window.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    blurTimer = 0;
  });
  window.addEventListener('pagehide', () => {
    abortHold(true);
    captureBaseRate();
    flushRate();
  });
  window.addEventListener('beforeunload', () => {
    abortHold(true);
    captureBaseRate();
    flushRate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      abortHold(true);
      captureBaseRate();
      flushRate();
    }
  });

  if (!isTopFrame) {
    // 冷启动的新 frame 主动向父 frame 要一次设置值，
    // 不必等 chrome.storage 回调，也不依赖同源 localStorage。
    try {
      window.parent.postMessage({ tag: HOLD_SYNC_TAG, type: HOLD_SYNC_REQUEST }, '*');
    } catch (error) {
      // 父 frame 不可达时仍由 chrome.storage 兜底。
    }
  }

  loadHoldDelay();
  watchHoldDelay();
  loadSavedRate();
})();
