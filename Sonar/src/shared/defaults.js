/* Base compartilhada — script clássico carregado em todos os contextos
 * (service worker, content scripts, offscreen, popup, opções e boas-vindas). */
/* eslint-disable no-var */

var SONAR_DEFAULTS = Object.freeze({
  setupDone: false, // a tela de boas-vindas já baixou um modelo?
  localModel: 'Xenova/whisper-base.en',
  localDevice: 'wasm', // 'wasm' (CPU) | 'webgpu'
  multiThread: true,
  autoSolve: false,
  autoClickCheckbox: false,
  humanTyping: false, // desligado = resposta de uma vez (mais rápido)
  maxAttempts: 4,
  theme: 'auto', // 'auto' | 'light' | 'dark'
});

var SONAR_MODELS = Object.freeze([
  {
    id: 'Xenova/whisper-tiny.en',
    name: 'Tiny',
    size: 39,
    speed: 3,
    accuracy: 1,
    note: 'O mais leve. Bom para PCs modestos.',
  },
  {
    id: 'Xenova/whisper-base.en',
    name: 'Base',
    size: 73,
    speed: 2,
    accuracy: 2,
    note: 'Equilíbrio entre velocidade e acerto.',
    recommended: true,
  },
  {
    id: 'Xenova/whisper-small.en',
    name: 'Small',
    size: 237,
    speed: 1,
    accuracy: 3,
    note: 'Acerta mais em áudios difíceis, porém é mais lento.',
  },
]);

/** Nome do cache onde o transformers.js guarda os modelos baixados. */
var SONAR_CACHE = 'transformers-cache';

/** Lê as configurações (com padrões) em uma única chamada. */
function sonarGetSettings() {
  return chrome.storage.local.get(SONAR_DEFAULTS);
}

/** Modelos já baixados: { [id]: { bytes, complete } }. Só em páginas da extensão. */
async function sonarModelCache() {
  const info = {};
  if (!(await caches.has(SONAR_CACHE))) return info;
  const cache = await caches.open(SONAR_CACHE);
  for (const req of await cache.keys()) {
    const m = SONAR_MODELS.find((x) => req.url.includes(`/${x.id}/`));
    if (!m) continue;
    const i = (info[m.id] ||= { bytes: 0, files: 0 });
    i.bytes += Number((await cache.match(req))?.headers.get('content-length')) || 0;
    if (/_model(_merged)?_quantized\.onnx$/.test(req.url)) i.files++;
  }
  for (const i of Object.values(info)) i.complete = i.files >= 2; // encoder + decoder
  return info;
}

/** Envia uma mensagem ao motor (offscreen), criando-o antes.
 *  Repete uma vez se o motor pedir (ex.: caiu para 1 núcleo). */
async function sonarEngine(message) {
  let r = null;
  for (let i = 0; i < 2; i++) {
    const prep = await chrome.runtime.sendMessage({ type: 'prepare' });
    if (!prep?.ok) throw new Error(prep?.error || 'Não foi possível iniciar o reconhecimento de voz.');
    r = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    if (r?.ok) return r;
    if (r?.code !== 'RETRY') break;
  }
  throw new Error(r?.error || 'O motor de voz falhou.');
}

/** Transcreve o áudio (base64) com o modelo escolhido. */
function sonarTranscribe(audio, { localModel, localDevice }) {
  return sonarEngine({ type: 'transcribe', audio, localModel, localDevice });
}

/** Baixa (se preciso), carrega e aquece um modelo. */
function sonarLoadModel(model, device) {
  return sonarEngine({ type: 'preload', model, device });
}

/** Aquece o modelo em segundo plano. Antes da configuração inicial não baixa nada sozinho. */
function sonarWarmup(settings) {
  if (!settings.setupDone) return;
  chrome.runtime
    .sendMessage({ type: 'prepare' })
    .then((p) => {
      if (p?.ok && !p.warm) return sonarLoadModel(settings.localModel, settings.localDevice);
    })
    .catch(() => {});
}

function sonarBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',', 2)[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
