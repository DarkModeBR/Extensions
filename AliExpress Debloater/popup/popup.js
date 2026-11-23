/* Popup: liga/desliga recursos (chrome.storage.local) e mostra o que foi limpo na aba. */
'use strict';

const store = chrome.storage.local;
const darkBox = document.getElementById('dark');
const featureBoxes = [...document.querySelectorAll('[data-feature]')];

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

/* ---------- configurações ----------
   dark: boolean (modo escuro)
   off:  lista dos recursos DESLIGADOS (vazia = tudo ligado) */

store.get(['dark', 'off']).then(({ dark, off }) => {
  const disabled = new Set(Array.isArray(off) ? off : []);
  darkBox.checked = !!dark;
  for (const box of featureBoxes) box.checked = !disabled.has(box.dataset.feature);
  document.documentElement.classList.toggle('dark', !!dark);
});

darkBox.addEventListener('change', () => {
  store.set({ dark: darkBox.checked });
  document.documentElement.classList.toggle('dark', darkBox.checked);
});

for (const box of featureBoxes) {
  box.addEventListener('change', () => {
    const off = featureBoxes.filter((b) => !b.checked).map((b) => b.dataset.feature);
    store.set({ off });
  });
}

/* ---------- "nesta aba" ---------- */

async function loadStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Rejeita quando a aba não é do AliExpress (não há content script para responder)
    const stats = await chrome.tabs.sendMessage(tab.id, { type: 'adb-stats' });
    if (!stats) return;
    document.getElementById('stat-ads').textContent = stats.ads;
    document.getElementById('stat-tags').textContent = stats.tags;
    document.getElementById('stat-prices').textContent = stats.prices;
    document.getElementById('stats-note').textContent = 'Encontrados nesta aba';
    document.getElementById('stats').classList.remove('empty');
  } catch (_) {
    // mantém a mensagem padrão ("Abra uma página do AliExpress...")
  }
}

loadStats();
