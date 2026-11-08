'use strict';

// 回归：全屏后「自定义长按触发延迟」失效。
// 场景 A：全屏重建出来的 frame 里 localStorage 为空、chrome.storage 异步才返回，
//         同时原生视频控件抢焦点触发 blur；400ms 设置仍必须准时生效。
// 场景 B：全屏 iframe（非顶层 frame）通过父 frame 的 postMessage 拿到设置值，
//         不依赖同源 localStorage，也不依赖 chrome.storage 的异步回调。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HOLD_TAG = 'wqxt-player-enhance/v1';
const HOLD_KEY = 'wqxt-player-hold-delay-v1';
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.style = {};
    this.id = '';
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.isConnected = true;
    this._classes = new Set();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c)
    };
    this.offsetWidth = 180;
    this.offsetHeight = 42;
  }
  matches() { return false; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  attachShadow() {
    const host = this;
    return {
      innerHTML: '',
      querySelector: (selector) => {
        if (!host._shadowParts) host._shadowParts = {};
        if (!host._shadowParts[selector]) host._shadowParts[selector] = new FakeElement('div');
        return host._shadowParts[selector];
      }
    };
  }
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
  }
}

function createInstance(options) {
  const listeners = { window: {}, document: {} };
  const video = new FakeElement('video');
  video.playbackRate = 1.5;
  video.paused = false;
  video.videoWidth = 1920;
  video.videoHeight = 1080;

  const docRoot = new FakeElement('html');
  const body = new FakeElement('body');
  docRoot.appendChild(body);

  const localData = {};
  if (options.localHoldDelay !== null && options.localHoldDelay !== undefined) {
    localData[HOLD_KEY] = String(options.localHoldDelay);
  }

  const document = {
    documentElement: docRoot,
    body,
    fullscreenElement: video,
    hidden: false,
    readyState: 'complete',
    hasFocus: () => false,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (selector) => (selector === 'video' ? [video] : []),
    createTreeWalker: () => ({ currentNode: null, nextNode: () => false }),
    addEventListener: (type, fn) => { (listeners.document[type] ||= []).push(fn); },
    removeEventListener: () => {},
    exitFullscreen: () => {}
  };

  const childFrame = {
    received: [],
    postMessage(payload) { this.received.push(payload); }
  };
  const parentFrame = {
    sent: [],
    postMessage(payload) { this.sent.push(payload); }
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    frames: [childFrame],
    parent: null,
    top: null,
    localStorage: {
      _data: localData,
      getItem(key) { return this._data[key] ?? null; },
      setItem(key, value) { this._data[key] = String(value); }
    },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (type, fn) => { (listeners.window[type] ||= []).push(fn); },
    removeEventListener: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  window.parent = options.child ? parentFrame : window;
  window.top = options.child ? {} : window;

  const storage = {
    'wqxt-player-base-rate-v2': 1.5,
    'wqxt-player-boost-rate-v2': 2.5,
    [HOLD_KEY]: options.holdDelay
  };
  const chrome = {
    storage: {
      local: {
        get(defaults, cb) {
          const result = {};
          for (const key of Object.keys(defaults)) result[key] = storage[key] ?? defaults[key];
          setTimeout(() => cb(result), options.storageGetDelay);
        },
        set(values) { Object.assign(storage, values); }
      },
      onChanged: { addListener: () => {} }
    }
  };

  const context = {
    window,
    document,
    chrome,
    Element: FakeElement,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    WeakSet,
    Map,
    JSON,
    URL,
    Blob: class {},
    fetch: () => Promise.reject(new Error('no network')),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    NodeFilter: { SHOW_ELEMENT: 1 }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'content.js' });

  function keyEvent(type, repeat, timeStamp) {
    return {
      key: 'ArrowRight',
      keyCode: 39,
      repeat,
      timeStamp,
      isComposing: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: video,
      composedPath: () => [video],
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {}
    };
  }

  return {
    video,
    window,
    docRoot,
    childFrame,
    parentFrame,
    fireWindow(type, event) {
      for (const fn of listeners.window[type] || []) fn(event);
    },
    fireDocument(type, event) {
      for (const fn of listeners.document[type] || []) fn(event);
    },
    keyDown(repeat = false, timeStamp = 0) {
      for (const fn of listeners.window.keydown || []) fn(keyEvent('keydown', repeat, timeStamp));
    },
    keyUp(timeStamp = 0) {
      for (const fn of listeners.window.keyup || []) fn(keyEvent('keyup', false, timeStamp));
    },
    localHoldDelay() {
      return window.localStorage.getItem(HOLD_KEY);
    },
    hudShown() {
      const host = docRoot.children.find((node) => node.id === 'wqxt-player-enhance-host');
      const hud = host && host._shadowParts && host._shadowParts['.hud'];
      return Boolean(hud && hud._classes.has('show'));
    },
    hudText() {
      const host = docRoot.children.find((node) => node.id === 'wqxt-player-enhance-host');
      const hud = host && host._shadowParts && host._shadowParts['.hud'];
      return hud ? String(hud.textContent || '') : '';
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function holdSequence(inst, checkAt, boostAt) {
  const repeats = setInterval(() => inst.keyDown(true), 20);
  await wait(checkAt);
  const earlyRate = inst.video.playbackRate;
  await wait(boostAt - checkAt);
  const boosted = inst.video.playbackRate;
  const hudText = inst.hudText();
  clearInterval(repeats);
  inst.keyUp(2000);
  await wait(70);
  return { earlyRate, boosted, hudText, restored: inst.video.playbackRate };
}

async function scenarioA() {
  const inst = createInstance({
    holdDelay: 400,
    localHoldDelay: null,
    storageGetDelay: 50,
    child: false
  });

  await wait(10);
  inst.fireDocument('fullscreenchange', {});
  inst.fireWindow('blur', {});
  await wait(10);
  inst.keyDown(false, 1000);

  const { earlyRate, boosted, hudText, restored } = await holdSequence(inst, 180, 430);
  const syncedToChild = inst.childFrame.received.some((m) => m.value === 400);
  const cached = inst.localHoldDelay();
  const pass = earlyRate === 1.5 && boosted === 2.5 && restored === 1.5 &&
    hudText === '2.5×' && syncedToChild && cached === '400' && !inst.hudShown();

  return { name: 'A: 全屏 + 冷启动 + blur', holdDelay: 400, earlyRate, boosted, hudText, restored, syncedToChild, cached, pass };
}

async function scenarioB() {
  const inst = createInstance({
    holdDelay: 400,
    localHoldDelay: null,
    storageGetDelay: 200,
    child: true
  });

  const requested = inst.parentFrame.sent.some((m) => m.type === 'hold-delay-request');
  await wait(6);
  inst.fireWindow('message', {
    data: { tag: HOLD_TAG, type: 'hold-delay-sync', value: 400 },
    source: inst.window.parent
  });
  await wait(14);
  inst.keyDown(false, 1000);

  const { earlyRate, boosted, hudText, restored } = await holdSequence(inst, 180, 430);
  const syncedToChild = inst.childFrame.received.some((m) => m.value === 400);
  const pass = requested && earlyRate === 1.5 && boosted === 2.5 && restored === 1.5 &&
    hudText === '2.5×' && syncedToChild && !inst.hudShown();

  return { name: 'B: 全屏 iframe 跨 frame 同步', holdDelay: 400, requested, earlyRate, boosted, hudText, restored, syncedToChild, pass };
}

(async () => {
  const results = [await scenarioA(), await scenarioB()];
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every((result) => result.pass) ? 0 : 1);
})();
