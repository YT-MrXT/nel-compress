import { imageMode, validateImage, describeImage, compressImage, isLossless } from './image.js';
import { videoMode, validateVideo, describeVideo, compressVideo } from './video.js';
import { patchVideo, pixelCost } from './patcher.js';

const el = (id) => document.getElementById(id);

// Caminho relativo ao index.html. O ficheiro .onnx.data TEM de estar na
// mesma pasta com o mesmo nome-base — onnxruntime-web procura-o
// automaticamente ao lado do .onnx.

const tabs = document.querySelector('.tabs');
const dropzone = el('dropzone');
const fileInput = el('fileInput');
const quality = el('quality');
const steps = document.querySelectorAll('.step');

const panels = {
  drop: el('panel-drop'),
  setup: el('panel-setup'),
  work: el('panel-work'),
  done: el('panel-done'),
};

let mode = 'image';
let sourceFile = null;
let sourceMeta = null;
let resultBlob = null;

// ---------- helpers ----------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

const STEP_OF_PANEL = { drop: 1, setup: 2, work: 2, done: 3 };

function show(name) {
  Object.values(panels).forEach((panel) => panel.classList.remove('is-shown'));
  panels[name].classList.add('is-shown');

  const current = STEP_OF_PANEL[name];
  steps.forEach((step, index) => {
    step.classList.toggle('is-active', index === current - 1);
    step.classList.toggle('is-done', index < current - 1);
  });
}

function showAlert(message) {
  el('alert').textContent = message;
  el('alert').classList.add('is-shown');
}

function clearAlert() {
  el('alert').classList.remove('is-shown');
}

const MODES = {
  image: imageMode,
  video: videoMode,
  patcher: {
    accept: videoMode.accept,
    pageTitle: 'Patcher — dobrar frames com IA',
    heading: 'Escolhe o teu vídeo',
    formats: videoMode.formats,
    selectLabel: videoMode.selectLabel,
    note: 'Isto gera frames novos com IA — não é compressão. O ficheiro final costuma ficar maior, não mais pequeno.',
    lede: 'Gera frames novos entre os reais para dobrar o fps aparente do vídeo. É lento (minutos) e experimental.',
    setupHeading: 'Confirma antes de começar',
    setupSub: 'O processo corre inteiramente no teu browser e pode demorar vários minutos.',
    steps: ['Ficheiro', 'Confirmar', 'Transferir'],
    action: 'Gerar frames',
  },
};

function currentMode() {
  return MODES[mode];
}

// Cada método é um par (resolução, fps de destino). O 'double' significa
// dobrar o que o vídeo já tiver.
const PATCHER_METHODS = {
  max:      { shortSide: 1080,     targetFps: 'double' },
  fps:      { shortSide: 'source', targetFps: 'double' },
  '720p60': { shortSide: 720,      targetFps: 60 },
};

function patcherSettings() {
  return { ...PATCHER_METHODS[el('patcherPreset').value], smaller: el('patcherSmaller').checked };
}

function updatePatcherNote() {
  const { shortSide, targetFps } = patcherSettings();

  if (!sourceMeta) {
    el('patcherNote').textContent = 'Escolhe um ficheiro para ver quanto tempo cada método leva.';
    return;
  }

  const lado = shortSide === 'source' ? Math.min(sourceMeta.width, sourceMeta.height) : shortSide;
  const custo = pixelCost(sourceMeta, lado);
  const vezes = (pixelCost(sourceMeta, 1080) / custo).toFixed(1);

  // Os fps do vídeo só se sabem ao contá-los durante a descodificação, por
  // isso aqui diz-se a condição em vez de se afirmar o que ainda não sabemos.
  const velocidade = custo > pixelCost(sourceMeta, 1080)
    ? 'Mantém a resolução original, por isso é o método mais pesado de todos.'
    : `Cerca de ${vezes}× mais rápido que o método de 1080p.`;

  el('patcherNote').textContent = targetFps === 'double'
    ? `${velocidade} Gera frames novos com IA, por isso o ficheiro final costuma ficar maior.`
    : `${velocidade} Se o vídeo já tiver ${targetFps}fps, não há frames para gerar e fica quase instantâneo.`;
}

function updateNote() {
  if (mode === 'image') {
    el('setupNote').textContent = isLossless(el('format').value)
      ? 'O PNG não tem perdas: o valor de qualidade não se aplica e o ficheiro fica quase sempre maior. Escolhe WebP ou JPG para o encolher.'
      : currentMode().note;
  } else {
    el('setupNote').textContent = currentMode().note;
  }
}

// ---------- modo ----------

function setMode(next) {
  mode = next;
  tabs.dataset.mode = next;

  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.mode === next;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  const config = currentMode();
  fileInput.accept = config.accept;
  el('pageTitle').textContent = config.pageTitle;
  el('pageLede').textContent = config.lede;
  el('setupHeading').textContent = config.setupHeading;
  el('setupSub').textContent = config.setupSub;
  el('dropHeading').textContent = config.heading;
  el('dropSub').textContent = config.formats;
  el('dropTitle').textContent = config.selectLabel;
  el('setupNote').textContent = config.note;
  el('compressBtn').textContent = config.action;
  el('videoPicks').hidden = next !== 'video';
  el('imagePicks').hidden = next !== 'image';
  el('patcherPicks').hidden = next !== 'patcher';
  updatePatcherNote();
  el('dial').hidden = next === 'patcher';

  config.steps.forEach((word, index) => {
    el(`stepWord${index + 1}`).textContent = word;
  });

  reset();
}

// ---------- intake ----------

async function intake(file) {
  clearAlert();

  const VALIDATE = { image: validateImage, video: validateVideo, patcher: validateVideo };
  const DESCRIBE = { image: describeImage, video: describeVideo, patcher: describeVideo };

  try {
    VALIDATE[mode](file);
  } catch (err) {
    console.error('nel-compress validation error:', err);
    showAlert(err?.message || String(err) || 'Ficheiro inválido.');
    return;
  }

  sourceFile = file;
  el('fileName').textContent = file.name;
  el('thumb').style.backgroundImage = file.type.startsWith('image/')
    ? `url(${URL.createObjectURL(file)})`
    : 'none';

  show('setup');

  sourceMeta = await DESCRIBE[mode](file);
  el('fileSub').textContent = `${sourceMeta.label} · ${formatBytes(file.size)}`;
  if (mode === 'patcher') updatePatcherNote();
  updateNote();
}

// ---------- compressão ----------

async function run() {
  clearAlert();
  show('work');
  el('workLabel').textContent = mode === 'patcher' ? 'A gerar frames' : 'A comprimir';
  el('trackFill').style.width = '0%';

  const q = Number(quality.value);

  try {
    if (mode === 'image') {
      el('trackFill').style.width = '60%';
      resultBlob = await compressImage(sourceFile, q, el('format').value);
    } else if (mode === 'patcher') {
      resultBlob = await patchVideo(sourceFile, sourceMeta, {
        ...patcherSettings(),
        onStatus: (msg) => { el('workSub').textContent = msg; },
        onProgress: (p) => {
          el('workLabel').textContent = `A gerar frames · ${Math.round(p * 100)}%`;
          el('trackFill').style.width = `${p * 100}%`;
        },
      });
    } else {
      const settings = {
        quality: q,
        shortSide: el('resolution').value,
        fps: el('fps').value,
      };

      resultBlob = await compressVideo(sourceFile, sourceMeta, settings, {
        onLoadProgress: () => {
          el('workLabel').textContent = 'A preparar';
        },
        onProgress: (p) => {
          el('workLabel').textContent = `A comprimir · ${Math.round(p * 100)}%`;
          el('trackFill').style.width = `${p * 100}%`;
        },
      });
    }
  } catch (err) {
    console.error('nel-compress error:', err);
    showAlert(err?.message || String(err) || 'Ocorreu um erro inesperado. Vê a consola (F12) para detalhes.');
    show('setup');
    return;
  }

  el('trackFill').style.width = '100%';
  renderResult();
}

function renderResult() {
  const before = sourceFile.size;
  const after = resultBlob.size;
  const saved = Math.round((1 - after / before) * 100);

  el('verdictNum').textContent = `${saved >= 0 ? '−' : '+'}${Math.abs(saved)}%`;
  document.querySelector('.verdict-word').textContent = mode === 'patcher'
    ? (saved >= 0 ? 'mais leve' : 'mais pesado (normal com o Patcher)')
    : (saved >= 0 ? 'mais leve' : 'mais pesado');

  el('sizeBefore').textContent = formatBytes(before);
  el('sizeAfter').textContent = formatBytes(after);
  el('barBefore').style.setProperty('--w', Math.min(before / Math.max(before, after), 1));
  el('barAfter').style.setProperty('--w', Math.min(after / Math.max(before, after), 1));

  show('done');
}

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

function download() {
  const baseName = sourceFile.name.replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(resultBlob);
  link.download = `${baseName}-nelcompress.${EXTENSIONS[resultBlob.type]}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function reset() {
  sourceFile = null;
  sourceMeta = null;
  resultBlob = null;
  fileInput.value = '';
  clearAlert();
  show('drop');
}

// ---------- ligações ----------

tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && tab.dataset.mode !== mode) setMode(tab.dataset.mode);
});

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('is-over');
});

dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('is-over');
  if (e.dataTransfer.files[0]) intake(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) intake(fileInput.files[0]);
});

quality.addEventListener('input', () => {
  el('qualityValue').textContent = quality.value;
  const percent = ((quality.value - quality.min) / (quality.max - quality.min)) * 100;
  quality.style.setProperty('--fill', `${percent}%`);
});

el('format').addEventListener('change', updateNote);
el('patcherPreset').addEventListener('change', updatePatcherNote);
el('patcherSmaller').addEventListener('change', updatePatcherNote);
el('compressBtn').addEventListener('click', run);
el('swapBtn').addEventListener('click', reset);
el('againBtn').addEventListener('click', reset);
el('downloadBtn').addEventListener('click', download);

quality.dispatchEvent(new Event('input'));
setMode('image');
