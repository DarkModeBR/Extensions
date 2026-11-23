/*! LinkLimpo — página de configurações. Licença: LGPL-3.0-or-later. */
'use strict';

const $ = (id) => document.getElementById(id);
const PAGES = ['protection', 'rules', 'paused', 'activity'];

// Cada opção: chave em settings → textos opt_<chave> e opt_<chave>_desc no _locales.
const TOGGLES = {
  protection: ['cleanLinks', 'redirectSkipping', 'historyCleaning', 'domainBlocking', 'pingBlocking', 'allowReferralMarketing'],
  interface: ['showBadge', 'contextMenus'],
  advanced: ['etagRemoval', 'skipLocalHosts', 'cleanSubresources'],
  rules: ['extraRules', 'autoUpdateRules'],
  activity: ['logEnabled'],
};

const CUSTOM_EXAMPLE = {
  extend: {
    globalRules: { rules: ['meu_parametro', 'campanha_[a-z]+'] },
  },
  providers: {
    'exemplo.com.br': {
      urlPattern: '^https?:\\/\\/(?:[a-z0-9-]+\\.)*?exemplo\\.com\\.br',
      rules: ['origem', 'clique_id'],
      exceptions: ['^https?:\\/\\/(?:[a-z0-9-]+\\.)*?exemplo\\.com\\.br\\/login'],
      redirections: ['^https?:\\/\\/(?:[a-z0-9-]+\\.)*?exemplo\\.com\\.br\\/sair\\?url=([^&]+)'],
    },
  },
  disable: [],
};

const HERO_URL = 'https://loja.exemplo.com.br/produto/123?utm_source=newsletter&utm_medium=email&cor=azul&fbclid=IwAR0abc';
const HERO_REMOVED = ['utm_source', 'utm_medium', 'fbclid'];
const HERO_CLEAN = 'https://loja.exemplo.com.br/produto/123?cor=azul';

let state = null;
let intervalSelect = null;
const applied = {};

/* ------------------------------------------------------------ navegação */

function route() {
  const hash = (location.hash || '#protection').slice(1);
  const current = PAGES.includes(hash) ? hash : 'protection';
  for (const id of PAGES) $('page-' + id).hidden = id !== current;
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.getAttribute('href') === '#' + current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('content').scrollTop = 0;
  renderHero(hash === 'welcome');
  if (current === 'activity') renderActivity();
}

/* ------------------------------------------------------------- opções */

function buildToggles() {
  for (const [group, keys] of Object.entries(TOGGLES)) {
    const box = $('toggles-' + group);
    for (const key of keys) {
      box.append(
        el(
          'label',
          { class: 'opt' },
          el('span', { class: 'text' }, el('span', { class: 'name', text: t('opt_' + key) }), el('span', { class: 'desc', text: t('opt_' + key + '_desc') })),
          el('input', { type: 'checkbox', class: 'toggle', 'data-key': key })
        )
      );
    }
  }
  for (const input of document.querySelectorAll('input[data-key]')) {
    input.addEventListener('change', () => save({ [input.dataset.key]: input.checked }));
  }
}

async function save(patch) {
  state.settings = await send('setSettings', { patch });
  await refreshState();
}

function renderSettings() {
  const s = state.settings;
  for (const input of document.querySelectorAll('input[data-key]')) input.checked = !!s[input.dataset.key];
  document.querySelector('.app').classList.toggle('disabled', !s.enabled);
  $('masterLabel').textContent = s.enabled ? t('statusOn') : t('statusOff');
  const side = $('sideState');
  side.classList.toggle('off', !s.enabled);
  side.querySelector('span').textContent = s.enabled ? t('statusOn') : t('statusOff');
  $('brandLogo').src = s.enabled ? '../../icons/on-48.png' : '../../icons/off-48.png';
  intervalSelect.set(s.updateIntervalHours);
  // Só sobrescreve os campos de texto quando o valor salvo mudou — edições não salvas ficam.
  for (const [id, key] of [['customRules', 'customRules'], ['rulesUrl', 'rulesUrl'], ['rulesHashUrl', 'rulesHashUrl']]) {
    const v = s[key] || '';
    if (applied[key] !== v) {
      $(id).value = v;
      applied[key] = v;
    }
  }
  renderPaused();
  renderHero(location.hash === '#welcome');
}

function renderHero(welcome) {
  if (!state) return;
  const on = state.settings.enabled;
  $('hero').classList.toggle('off', !on);
  $('heroTitle').textContent = welcome ? t('welcomeTitle') : on ? t('heroTitle') : t('heroTitleOff');
  $('heroText').textContent = welcome ? t('welcomeText') : on ? t('heroText') : t('heroTextOff');
  if (!$('heroBefore').firstChild) {
    const anatomy = renderAnatomy(HERO_URL, HERO_REMOVED);
    anatomy.querySelectorAll('.cut').forEach((n, i) => n.style.setProperty('--i', i));
    $('heroBefore').append(anatomy);
    $('heroAfter').textContent = HERO_CLEAN;
  }
}

/* -------------------------------------------------------------- regras */

function renderRules() {
  const box = $('rulesStatus');
  box.replaceChildren();
  const ri = state.rulesInfo;
  const us = state.rulesUpdateStatus;
  if (!ri) {
    box.append(el('div', {}, el('div', { class: 'k', text: t('rulesLoading') })));
    return;
  }
  const cell = (k, v, small) => el('div', {}, el('div', { class: 'k', text: k }), el('div', { class: 'v' + (small ? ' small' : ''), text: v }));
  box.append(
    cell(t('rulesProviders'), fmt(ri.providers)),
    cell(t('rulesNetwork'), ri.dnr ? fmt(ri.dnr.rules) : '—'),
    cell(t('rulesSource'), ri.source === 'remote' ? t('rulesSourceRemote') : t('rulesSourceBundled'), true),
    cell(t('rulesUpdated'), fmtDate(ri.fetchedAt), true),
    cell(t('rulesChecked'), us ? fmtDate(us.checkedAt) : '—', true),
    cell('SHA-256', ri.hash ? ri.hash.slice(0, 16) + '…' : '—', true)
  );
  $('sideRules').textContent = t('popupRules', [fmt(ri.providers)]);
  if (us && us.error && !$('rulesMsg').textContent) setMsg('rulesMsg', t('rulesUpdateError', [us.error]), 'err');
  if (ri.customError) setMsg('customMsg', t('rulesCustomInvalid', [ri.customError]), 'err');
}

function setMsg(id, text, kind) {
  const node = $(id);
  node.textContent = text;
  node.classList.remove('msg-ok', 'msg-err', 'muted');
  node.classList.add(kind === 'err' ? 'msg-err' : kind === 'ok' ? 'msg-ok' : 'muted');
}

/** Ações destrutivas pedem um segundo clique (sem diálogos que travam a página). */
function armed(btn, msgId, text) {
  if (btn.classList.contains('armed')) {
    btn.classList.remove('armed');
    return true;
  }
  btn.classList.add('armed');
  setMsg(msgId, text);
  setTimeout(() => btn.classList.remove('armed'), 4000);
  return false;
}

$('rulesUpdate').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('busy');
  setMsg('rulesMsg', t('rulesUpdating'));
  try {
    const st = await send('updateRules');
    if (st.error) setMsg('rulesMsg', t('rulesUpdateError', [st.error]), 'err');
    else setMsg('rulesMsg', st.changed ? t('rulesUpdatedNew') : t('rulesUpToDate'), 'ok');
  } catch (err) {
    setMsg('rulesMsg', String(err.message || err), 'err');
  }
  btn.disabled = false;
  btn.classList.remove('busy');
  await refreshState();
});

$('rulesReset').addEventListener('click', async () => {
  await send('resetRules');
  setMsg('rulesMsg', t('rulesBundledInUse'), 'ok');
  await refreshState();
});

$('customSave').addEventListener('click', async () => {
  const text = $('customRules').value.trim();
  if (text) {
    try {
      JSON.parse(text);
    } catch (err) {
      setMsg('customMsg', t('rulesCustomInvalid', [err.message]), 'err');
      return;
    }
  }
  await save({ customRules: text });
  const ri = state.rulesInfo;
  if (ri && ri.customError) setMsg('customMsg', t('rulesCustomInvalid', [ri.customError]), 'err');
  else setMsg('customMsg', text ? t('rulesCustomSaved', [fmt(ri ? ri.customProviders : 0)]) : t('saved'), 'ok');
});

$('customExample').addEventListener('click', (e) => {
  if ($('customRules').value.trim() && !armed(e.currentTarget, 'customMsg', t('rulesCustomReplaceConfirm'))) return;
  $('customRules').value = JSON.stringify(CUSTOM_EXAMPLE, null, 2);
  setMsg('customMsg', '');
  $('customRules').focus();
});

// Tab no editor insere espaços em vez de sair do campo.
$('customRules').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey) return;
  e.preventDefault();
  const ta = e.currentTarget;
  ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
});

$('sourcesSave').addEventListener('click', async () => {
  const rulesUrl = $('rulesUrl').value.trim();
  const rulesHashUrl = $('rulesHashUrl').value.trim();
  if (!/^https:\/\//.test(rulesUrl) || !/^https:\/\//.test(rulesHashUrl)) {
    setMsg('rulesMsg', t('rulesHttpsOnly'), 'err');
    return;
  }
  await save({ rulesUrl, rulesHashUrl });
  setMsg('rulesMsg', t('saved'), 'ok');
});

/* ------------------------------------------------------ sites pausados */

function renderPaused() {
  const list = $('pausedList');
  const sites = state.settings.pausedSites;
  list.replaceChildren();
  for (const d of sites) {
    const btn = el('button', { type: 'button', class: 'icon-btn', title: t('remove'), 'aria-label': t('remove') + ' ' + d });
    btn.append(icon('x'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      state.settings = await send('togglePause', { host: d, paused: false });
      await refreshState();
    });
    list.append(el('li', {}, el('span', { class: 'initial', text: d[0] }), el('span', { class: 'domain', text: d, title: d }), btn));
  }
  $('pausedEmpty').hidden = sites.length > 0;
  const badge = $('pausedBadge');
  badge.hidden = sites.length === 0;
  badge.textContent = fmt(sites.length);
}

$('pausedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('pausedInput');
  const btn = $('pausedAddBtn');
  const value = input.value.trim();
  if (!value || btn.disabled) return;
  btn.disabled = true;
  try {
    const before = state.settings.pausedSites.length;
    // O service worker normaliza o domínio e grava em fila (sem corrida entre cliques).
    state.settings = await send('togglePause', { host: value, paused: true });
    await refreshState();
    if (state.settings.pausedSites.length === before) setMsg('pausedMsg', t('pausedInvalid'), 'err');
    else {
      input.value = '';
      setMsg('pausedMsg', '');
    }
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

/* ------------------------------------------------------------ atividade */

const KIND = { params: 'kindParams', redirect: 'kindRedirect', block: 'kindBlock', link: 'kindLink', history: 'kindHistory', ping: 'kindPing' };

function renderActivity() {
  if (!state) return;
  const st = state.stats || {};
  const totals = $('totals');
  totals.replaceChildren();
  for (const [k, label] of [['total', 'statTotal'], ['params', 'statParams'], ['links', 'statLinks'], ['redirects', 'statRedirects'], ['blocked', 'statBlocked']]) {
    totals.append(el('div', {}, el('dt', { text: t(label) }), el('dd', { text: fmt(st[k]) })));
  }
  $('since').textContent = t('statSince', [fmtDate(st.since)]);

  const body = $('log');
  body.replaceChildren();
  const entries = state.log || [];
  const empty = $('logEmpty');
  $('logWrap').hidden = entries.length === 0;
  empty.hidden = entries.length > 0;
  empty.querySelector('p').textContent = state.settings.logEnabled ? t('logEmpty') : t('logDisabled');
  for (const e of entries.slice(0, 300)) {
    const url = e.before ? renderAnatomy(e.before, e.removed || []) : el('span', { text: '—' });
    url.classList.add('nowrap');
    body.append(
      el(
        'tr',
        {},
        el('td', { class: 'when', text: fmtDate(e.t) }),
        el('td', { class: 'kind', text: t(KIND[e.kind] || 'kindParams') }),
        el('td', { class: 'rule', text: e.provider || '—' }),
        el('td', {}, url)
      )
    );
  }
}

$('statsReset').addEventListener('click', async (e) => {
  if (!armed(e.currentTarget, 'since', t('activityResetConfirm'))) return;
  state.stats = await send('resetStats');
  renderActivity();
});
$('logClear').addEventListener('click', async () => {
  await send('clearLog');
  state.log = [];
  renderActivity();
});

/* --------------------------------------------------------------- início */

async function refreshState() {
  state = await send('getState');
  renderSettings();
  renderRules();
  if (!$('page-activity').hidden) renderActivity();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.rulesInfo || changes.rulesUpdateStatus || changes.settings || changes.stats || changes.log) refreshState();
});

applyI18n();
for (const a of document.querySelectorAll('.nav a[data-icon]')) a.prepend(icon(a.dataset.icon));
$('rulesUpdate').prepend(icon('refresh'));
$('pausedAddBtn').prepend(icon('plus'));
$('version').textContent = t('aboutVersion', [chrome.runtime.getManifest().version]);
intervalSelect = customSelect({
  label: t('rulesInterval'),
  value: 24,
  options: [6, 12, 24, 72, 168].map((h) => ({ value: h, label: h < 48 ? t('everyHours', [h]) : t('everyDays', [h / 24]) })),
  onChange: (v) => save({ updateIntervalHours: Number(v) }),
});
$('intervalSlot').append(intervalSelect.root);
buildToggles();
window.addEventListener('hashchange', route);
refreshState().then(route);
