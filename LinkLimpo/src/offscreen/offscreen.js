/*! LinkLimpo — documento offscreen para copiar texto (service workers não acessam a área de transferência). */
'use strict';
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'copy' || sender.id !== chrome.runtime.id) return false;
  const area = document.getElementById('buffer');
  area.value = String(msg.text || '');
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  area.value = '';
  sendResponse({ ok });
  return false;
});
