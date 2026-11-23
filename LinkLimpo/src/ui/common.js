/*! LinkLimpo — utilidades das páginas da extensão. Licença: LGPL-3.0-or-later. */
'use strict';

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

function applyI18n(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

/** Envia uma mensagem ao service worker e devolve o resultado (ou lança o erro). */
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage(Object.assign({ type }, payload));
  if (!res) throw new Error('sem resposta');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

const nf = new Intl.NumberFormat(chrome.i18n.getUILanguage());
const fmt = (n) => nf.format(n || 0);

function fmtDate(ms) {
  if (!ms) return '—';
  return new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/**
 * Desenha uma URL com os trechos removidos riscados.
 * @param {string} before  URL original
 * @param {string[]} removed  nomes de parâmetros removidos
 */
function renderAnatomy(before, removed = []) {
  const box = el('div', { class: 'url' });
  let u;
  try {
    u = new URL(before);
  } catch (_) {
    box.textContent = before;
    return box;
  }
  const removedSet = new Set(removed.map((r) => r.toLowerCase()));
  const hashIdx = before.indexOf('#');
  const noHash = hashIdx === -1 ? before : before.slice(0, hashIdx);
  const hash = hashIdx === -1 ? null : before.slice(hashIdx + 1);
  const qIdx = noHash.indexOf('?');
  const head = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const query = qIdx === -1 ? null : noHash.slice(qIdx + 1);

  const hostStart = head.indexOf(u.host);
  if (hostStart > -1) {
    box.append(el('span', { class: 'sep', text: head.slice(0, hostStart) }));
    box.append(el('span', { class: 'host', text: u.host }));
    const rest = head.slice(hostStart + u.host.length);
    // rawRules (ex.: /ref=xyz da Amazon) aparecem no caminho
    const cutPath = removed.find((r) => r.startsWith('/') && rest.includes(r));
    if (cutPath) {
      const i = rest.indexOf(cutPath);
      box.append(el('span', { class: 'base', text: rest.slice(0, i) }));
      box.append(el('span', { class: 'cut', text: cutPath }));
      box.append(el('span', { class: 'base', text: rest.slice(i + cutPath.length) }));
    } else {
      box.append(el('span', { class: 'base', text: rest }));
    }
  } else {
    box.append(el('span', { class: 'base', text: head }));
  }

  const fields = (str, lead) => {
    str.split('&').forEach((part, i) => {
      if (!part) return;
      const key = decodeSafe(part.split('=')[0]).toLowerCase();
      box.append(el('span', { class: 'sep', text: i === 0 ? lead : '&' }));
      box.append(el('span', { class: removedSet.has(key) ? 'cut' : 'kept', text: part }));
    });
  };
  if (query !== null) fields(query, '?');
  if (hash !== null) {
    if (hash.includes('=')) fields(hash, '#');
    else box.append(el('span', { class: 'kept', text: '#' + hash }));
  }
  return box;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

const SVG = (body, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  copy: SVG('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  check: SVG('<path d="M20 6 9 17l-5-5"/>', 2.5),
  chevron: SVG('<path d="m6 9 6 6 6-6"/>'),
  x: SVG('<path d="M18 6 6 18M6 6l12 12"/>', 2.5),
  shield: SVG('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
  rules: SVG('<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>'),
  pause: SVG('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 9v6M14 9v6"/>'),
  activity: SVG('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', 1.8),
  refresh: SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>', 2.5),
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name];
  return span.firstChild;
}

/**
 * Menu de seleção desenhado do zero (o <select> nativo não pode ser estilizado por inteiro).
 * Acessível: botão com aria-haspopup="listbox", setas, Enter/Espaço, Esc e clique fora.
 * @returns {{root: HTMLElement, value: string, set(v: string): void}}
 */
function customSelect({ options, value, onChange, label }) {
  const id = 'sel-' + Math.random().toString(36).slice(2, 8);
  const root = el('div', { class: 'select' });
  const btn = el('button', { type: 'button', class: 'select-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label });
  const current = el('span');
  btn.append(current, icon('chevron'));
  const list = el('ul', { class: 'select-list thin-scroll', role: 'listbox', id, tabindex: '-1', hidden: true });
  let active = 0;
  const api = { root, value: String(value) };

  options.forEach((o, i) => {
    const li = el('li', { role: 'option', id: id + '-' + i, 'data-value': String(o.value) }, el('span', { text: o.label }), icon('check'));
    li.addEventListener('mousemove', () => highlight(i));
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => choose(i));
    list.append(li);
  });
  root.append(btn, list);

  const items = () => Array.from(list.children);
  function render() {
    const idx = Math.max(0, options.findIndex((o) => String(o.value) === api.value));
    current.textContent = options[idx] ? options[idx].label : api.value;
    items().forEach((li, i) => li.setAttribute('aria-selected', String(i === idx)));
  }
  function highlight(i) {
    active = (i + options.length) % options.length;
    items().forEach((li, j) => li.classList.toggle('active', j === active));
    list.setAttribute('aria-activedescendant', id + '-' + active);
    items()[active].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    if (!list.hidden) return;
    list.hidden = false;
    root.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    highlight(Math.max(0, options.findIndex((o) => String(o.value) === api.value)));
    list.focus();
    document.addEventListener('mousedown', outside, true);
  }
  function close(focusBtn = true) {
    if (list.hidden) return;
    list.hidden = true;
    root.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    if (focusBtn) btn.focus();
  }
  function outside(e) {
    if (!root.contains(e.target)) close(false);
  }
  function choose(i) {
    const v = String(options[i].value);
    const changed = v !== api.value;
    api.value = v;
    render();
    close();
    if (changed && onChange) onChange(v);
  }
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') highlight(active + 1);
    else if (e.key === 'ArrowUp') highlight(active - 1);
    else if (e.key === 'Home') highlight(0);
    else if (e.key === 'End') highlight(options.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape' || e.key === 'Tab') return close(e.key === 'Escape');
    else return;
    e.preventDefault();
  });
  list.addEventListener('blur', () => setTimeout(() => !root.contains(document.activeElement) && close(false), 0));

  api.set = (v) => {
    api.value = String(v);
    if (!options.some((o) => String(o.value) === api.value)) {
      // Valor vindo de configuração importada/antiga: mostra mesmo assim.
      options.push({ value: api.value, label: api.value + ' h' });
      const i = options.length - 1;
      const li = el('li', { role: 'option', id: id + '-' + i }, el('span', { text: options[i].label }), icon('check'));
      li.addEventListener('click', () => choose(i));
      list.append(li);
    }
    render();
  };
  render();
  return api;
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  if (button) {
    const label = button.querySelector('[data-label]');
    const original = label ? label.textContent : null;
    button.classList.add('done');
    if (label) label.textContent = t('copied');
    setTimeout(() => {
      button.classList.remove('done');
      if (label) label.textContent = original;
    }, 1400);
  }
}
