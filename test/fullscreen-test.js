'use strict';

// 最小 DOM 桩：只验证“原生视频全屏、getBoundingClientRect 为 0”时，
// 长按仍能识别到全屏 video 并进入加速。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

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

global.Element = FakeElement;
global.NodeFilter = { SHOW_ELEMENT: 1 };

const video = new FakeElement('video');
video.playbackRate = 1.5;
video.paused = false;
video.videoWidth = 1920;
video.videoHeight = 1080;

const docRoot = new FakeElement('html');
const body = new FakeElement('body');
docRoot.appendChild(body);

const listeners = { window: {}, document: {} };
const document = {
  documentElement: docRoot,
  body,
  fullscreenElement: video,
  hidden: false,
  readyState: 'complete',
  createElement: (tag) => new FakeElement(tag),
  querySelectorAll: (selector) => (selector === 'video' ? [video] : []),
  createTreeWalker: () => ({ currentNode: null, nextNode: () => false }),
  addEventListener: (type, fn) => { (listeners.document[type] ||= []).push(fn); },
  removeEventListener: () => {},
  hasFocus: () => true,
  exitFullscreen: () => {}
};

const window = {
  top: null,
  innerWidth: 1280,
  innerHeight: 720,
  localStorage: {
    _data: { 'wqxt-player-hold-delay-v1': '300' },
    getItem(key) { return this._data[key] ?? null; },
    setItem(key, value) { this._data[key] = String(value); }
  },
  sessionStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: (type, fn) => { (listeners.window[type] ||= []).push(fn); },
  removeEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  cancelAnimationFrame: (id) => clearTimeout(id)
};
window.top = window;

const storage = {
  'wqxt-player-base-rate-v2': 1.5,
  'wqxt-player-boost-rate-v2': 2.5,
  'wqxt-player-hold-delay-v1': 300
};
const chrome = {
  storage: {
    local: {
      get(defaults, cb) {
        const result = {};
        for (const key of Object.keys(defaults)) result[key] = storage[key] ?? defaults[key];
        cb(result);
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

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
vm.runInContext(source, context, { filename: 'content.js' });

function dispatch(type, repeat = false, timeStamp = 0) {
  const event = {
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
  for (const fn of listeners.window[type] || []) fn(event);
}

setTimeout(() => {
  dispatch('keydown', false, 1000);
  // 模拟上一次按下的 keyup 迟到，时间戳早于这次 keydown；不能清掉新计时器。
  dispatch('keyup', false, 999);
  // 模拟系统按键重复：重复事件不能重置长按计时。
  const repeats = setInterval(() => dispatch('keydown', true), 20);
  setTimeout(() => {
    // 300ms 设置下，180ms 时还不应该加速。
    const earlyRate = video.playbackRate;
    setTimeout(() => {
      const boosted = video.playbackRate;
      clearInterval(repeats);
      dispatch('keyup', false, 2000);
      setTimeout(() => {
        const restored = video.playbackRate;
        const host = docRoot.children.find((node) => node.id === 'wqxt-player-enhance-host');
        const hud = host && host._shadowParts && host._shadowParts['.hud'];
        const hudShownAfterRelease = Boolean(hud && hud._classes.has('show'));
        const pass = earlyRate === 1.5 && boosted === 2.5 && restored === 1.5 && !hudShownAfterRelease;
        console.log(JSON.stringify({
          fullscreenRect: video.getBoundingClientRect(),
          holdDelay: 300,
          earlyRate,
          boosted,
          restored,
          hudShownAfterRelease,
          pass
        }));
        process.exit(pass ? 0 : 1);
      }, 100);
    }, 220);
  }, 180);
}, 80);
