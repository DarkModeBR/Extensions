/*! LinkLimpo — página exibida quando um domínio de rastreamento é bloqueado. */
'use strict';

const url = decodeURIComponent(location.hash.slice(1) || '');
const valid = /^https?:\/\//i.test(url);

applyI18n();
document.getElementById('target').textContent = valid ? url : '—';

if (valid) {
  send('explainBlocked', { url })
    .then((r) => {
      document.getElementById('why').textContent = t('blockedWhy', [r.host, r.provider || '—']);
    })
    .catch(() => {});
}

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});

const proceed = document.getElementById('proceed');
proceed.disabled = !valid;
proceed.addEventListener('click', async () => {
  proceed.disabled = true;
  await send('allowBlockedOnce', { url });
  location.replace(url);
});
