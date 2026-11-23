/*! LinkLimpo — popup. Licença: LGPL-3.0-or-later. */
'use strict';

const $ = (id) => document.getElementById(id);
const KIND_LABEL = {
  params: 'kindParams',
  redirect: 'kindRedirect',
  block: 'kindBlock',
  link: 'kindLink',
  history: 'kindHistory',
  ping: 'kindPing',
};

let tabId = null;
let info = null;

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

function chips(list) {
  const box = el('span', { class: 'chips' });
  for (const name of list.slice(0, 12)) box.append(el('span', { class: 'chip', text: name }));
  if (list.length > 12) box.append(el('span', { class: 'muted', text: '+' + (list.length - 12) }));
  return box;
}

function renderSite() {
  const anatomy = $('anatomy');
  const verdict = $('verdict');
  anatomy.replaceChildren();
  verdict.replaceChildren();
  verdict.className = 'verdict';

  $('host').textContent = info.host || hostLabel(info.url);
  $('paused').checked = info.paused;

  // 1) Ainda há rastreamento na URL atual (ex.: site pausado ou proteção desligada).
  if (info.cleanUrl && info.cleanUrl !== info.url) {
    send('clean', { url: info.url }).then((r) => {
      const removed = r.matches.flatMap((m) => m.removed || []);
      anatomy.replaceChildren(renderAnatomy(info.url, removed));
      verdict.append(document.createTextNode(t('popupStillDirty') + ' '), chips(removed));
    });
    return;
  }

  // 2) Algo foi limpo nesta página: mostra o "antes", com o que saiu riscado.
  const pageEntry = (info.tab.entries || []).find(
    (e) => ['params', 'history', 'redirect', 'block'].includes(e.kind) && e.before
  );
  if (pageEntry) {
    const removed = pageEntry.removed || [];
    anatomy.append(renderAnatomy(pageEntry.before, removed));
    if (pageEntry.kind === 'redirect') {
      verdict.textContent = t('popupRedirected', [hostLabel(pageEntry.before), hostLabel(pageEntry.after || info.url)]);
    } else if (removed.length) {
      verdict.append(document.createTextNode(t('popupRemoved') + ' '), chips(removed));
    } else {
      verdict.textContent = t(KIND_LABEL[pageEntry.kind]);
    }
    return;
  }

  // 3) Nada a limpar.
  anatomy.append(renderAnatomy(info.url, []));
  verdict.append(icon('check'), document.createTextNode(t('popupNothing')));
  verdict.classList.add('clean');
}

function render() {
  const s = info.settings;
  const paused = s.enabled && info.paused;
  $('enabled').checked = s.enabled;
  document.body.classList.toggle('disabled', !s.enabled);
  document.body.classList.toggle('paused', paused);
  $('status').textContent = !s.enabled ? t('statusOff') : paused ? t('statusPaused') : t('statusOn');
  $('logo').src = s.enabled && !info.paused ? '../../icons/on-32.png' : '../../icons/off-32.png';
  $('off').hidden = s.enabled;
  $('site').hidden = !info.supported;
  $('unsupported').hidden = info.supported;

  const badge = parseInt(info.badge, 10);
  $('tabCount').textContent = fmt(Math.max(Number.isFinite(badge) ? badge : 0, info.tab.count || 0));
  $('totalCount').textContent = fmt(info.stats.total);

  const ri = info.rulesInfo;
  $('rules').textContent = ri ? t('popupRules', [fmt(ri.providers)]) : '';

  if (info.supported) renderSite();
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  if (tabId == null) return;
  info = await send('getTabInfo', { tabId });
  render();
}

$('enabled').addEventListener('change', async (e) => {
  await send('setSettings', { patch: { enabled: e.target.checked } });
  await load();
});

$('paused').addEventListener('change', async (e) => {
  await send('togglePause', { host: info.host, paused: e.target.checked });
  await load();
  // Recarrega a aba para aplicar (ou deixar de aplicar) as regras desde o início.
  if (tabId != null) chrome.tabs.reload(tabId);
});

$('copy').addEventListener('click', (e) => copyToClipboard(info.cleanUrl || info.url, e.currentTarget));

applyI18n();
$('copy').prepend(icon('copy'));
$('settingsLink').prepend(icon('settings'));
load().catch((err) => {
  console.error(err);
  $('verdict').textContent = String(err.message || err);
});
