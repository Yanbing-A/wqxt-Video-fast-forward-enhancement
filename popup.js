(() => {
  'use strict';

  const KEY = 'wqxt-player-hold-delay-v1';
  const DEFAULT = 100;
  const MIN = 10;
  const MAX = 500;

  const range = document.getElementById('hold-delay');
  const number = document.getElementById('hold-delay-number');
  const output = document.getElementById('hold-delay-value');
  const status = document.getElementById('hold-delay-status');
  const saveButton = document.getElementById('save-hold-delay');

  if (!range || !number || !output || !status || !saveButton) return;

  function normalise(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(Math.min(MAX, Math.max(MIN, value)));
  }

  function render(value) {
    const safe = normalise(value) ?? DEFAULT;
    range.value = String(safe);
    number.value = String(safe);
    output.textContent = `${safe}ms`;
  }

  function setStatus(text, ok) {
    status.textContent = text;
    status.classList.toggle('ok', Boolean(ok));
  }

  function load() {
    try {
      chrome.storage.local.get({ [KEY]: DEFAULT }, (result) => {
        render(normalise(result && result[KEY]) ?? DEFAULT);
        setStatus('', false);
      });
    } catch (error) {
      render(DEFAULT);
      setStatus('', false);
    }
  }

  function save() {
    const value = normalise(number.value);
    if (value === null) {
      setStatus(`${MIN}–${MAX}ms`, false);
      return;
    }

    render(value);
    try {
      chrome.storage.local.set({ [KEY]: value }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus('保存失败', false);
          return;
        }
        setStatus('已保存', true);
      });
    } catch (error) {
      setStatus('保存失败', false);
    }
  }

  range.addEventListener('input', () => {
    render(range.value);
    setStatus('', false);
  });

  number.addEventListener('input', () => {
    const value = normalise(number.value);
    if (value === null) return;
    range.value = String(value);
    output.textContent = `${value}ms`;
    setStatus('', false);
  });

  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });

  saveButton.addEventListener('click', save);

  load();
})();
