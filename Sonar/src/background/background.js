/* Service worker do Sonar.
 * - Cria/fecha o documento offscreen onde o Whisper roda.
 * - Guarda as estatísticas.
 * - Atalho de teclado.
 * A transcrição vai direto do content script ao offscreen, então o
 * service worker não precisa ficar acordado durante o processamento. */
importScripts('../shared/defaults.js');

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const WELCOME_PATH = 'src/welcome/welcome.html';
let creating = null;

/* ---------------- Offscreen ---------------- */

async function offscreenExists() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function pingOffscreen() {
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
  } catch (_) {
    return null;
  }
}

async function threadCount() {
  const { multiThread } = await sonarGetSettings();
  if (!multiThread) return 1;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}

async function ensureOffscreen() {
  if (await offscreenExists()) {
    const p = await pingOffscreen();
    if (p?.ok) return p;
  } else {
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Decodificar o áudio do CAPTCHA e rodar o reconhecimento de voz localmente.',
      })
      .catch((e) => {
        if (!String(e?.message).includes('single offscreen')) throw e;
      })
      .finally(() => (creating = null));
    await creating;
  }
  // Espera o offscreen registrar o listener (normalmente < 100 ms).
  for (let i = 0; i < 60; i++) {
    const p = await pingOffscreen();
    if (p?.ok) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('O motor de reconhecimento não respondeu.');
}

async function closeOffscreen() {
  if (await offscreenExists()) await chrome.offscreen.closeDocument().catch(() => {});
}

/* ---------------- Estatísticas ---------------- */

// Fila: dois resultados quase simultâneos não podem sobrescrever um ao outro.
let statsQueue = Promise.resolve();
const recordResult = (entry) =>
  (statsQueue = statsQueue.then(
    () => saveResult(entry),
    () => saveResult(entry)
  ));

async function saveResult({ result, ms = 0 }) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  const s = { solved: 0, failed: 0, totalMs: 0, ...stats };
  if (result === 'solved') {
    s.solved++;
    s.totalMs += ms;
  } else {
    s.failed++;
  }
  await chrome.storage.local.set({ stats: s });
  chrome.action.setBadgeBackgroundColor({ color: result === 'solved' ? '#2FA37E' : '#D9534F' });
  chrome.action.setBadgeText({ text: result === 'solved' ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

/* ---------------- Mensagens ---------------- */

const handlers = {
  prepare: () => ensureOffscreen().then((p) => ({ ok: true, ready: !!p.ready, warm: !!p.warm })),
  status: async () => {
    if (!(await offscreenExists())) return { ok: true, running: false };
    const p = await pingOffscreen();
    return { ok: true, running: !!p?.ok, ...p };
  },
  offscreenConfig: async () => ({ ok: true, threads: await threadCount() }),
  stat: (msg) => recordResult(msg).then(() => ({ ok: true })),
  // O offscreen avisa que vários núcleos falharam: volta para 1 e recria.
  threadsFailed: async () => {
    await chrome.storage.local.set({ multiThread: false });
    await closeOffscreen();
    return { ok: true };
  },
  offscreenIdle: () => closeOffscreen().then(() => ({ ok: true })),
  restartEngine: () => closeOffscreen().then(() => ({ ok: true })),
  solveActiveTab: async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) solveInTab(tab.id);
    return { ok: !!tab?.id };
  },
  openOptions: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
  openWelcome: () => openWelcome().then(() => ({ ok: true })),
};

/** Abre (ou foca) a tela de boas-vindas, onde o usuário escolhe e baixa o modelo. */
async function openWelcome() {
  const url = chrome.runtime.getURL(WELCOME_PATH);
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open?.tabId > 0) await chrome.tabs.update(open.tabId, { active: true });
  else await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target) return false; // mensagens para o offscreen ou a interface
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

/* ---------------- Atalho ---------------- */

function solveInTab(tabId) {
  // Vai para todos os frames: o bframe visível resolve; o anchor marca a caixa se preciso.
  chrome.tabs.sendMessage(tabId, { type: 'solveNow' }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'clickCheckbox' }).catch(() => {});
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'solve') return;
  const id = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (id) solveInTab(id);
});

/* ---------------- Ciclo de vida ---------------- */

/** "1.10.0" > "1.9.2" (comparação numérica por partes). */
function versionLess(a = '0', b = '0') {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason === 'install') return openWelcome();
  if (reason !== 'update') return;
  // Só uma vez, vindo de antes da 1.2.0: remove APIs remotas, histórico e o antigo padrão de digitação.
  if (versionLess(previousVersion, '1.2.0')) {
    await chrome.storage.local.remove([
      'engine',
      'witKey',
      'openaiUrl',
      'openaiKey',
      'openaiModel',
      'fallbackToLocal',
      'history',
      'humanTyping',
    ]);
  }
  // Até a 1.2.x o modelo vinha dentro da extensão; agora o usuário escolhe e baixa.
  if (versionLess(previousVersion, '1.3.0') && !(await sonarGetSettings()).setupDone) openWelcome();
});

// Mudou o número de núcleos? Fecha o motor; o próximo uso recria.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.multiThread) closeOffscreen();
});
