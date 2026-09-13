import { imageMode, validateImage, describeImage, compressImage, isLossless } from './image.js';
import { videoMode, validateVideo, describeVideo, compressVideo } from './video.js';
import { linkMode, validateForLink, describeForLink, uploadFile } from './link.js';

const el = (id) => document.getElementById(id);

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
  link: el('panel-link'),
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

const STEP_OF_PANEL = { drop: 1, setup: 2, work: 2, done: 3, link: 3 };

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

const MODES = { image: imageMode, video: videoMode, link: linkMode };

function currentMode() {
  return MODES[mode];
}

function updateNote() {
  el('setupNote').textContent =
    mode === 'image' && isLossless(el('format').value)
      ? 'O PNG não tem perdas: o valor de qualidade não se aplica e o ficheiro fica quase sempre maior. Escolhe WebP ou JPG para o encolher.'
      : currentMode().note;
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
  el('dial').hidden = next === 'link';
  el('linkWarning').hidden = next !== 'link';

  config.steps.forEach((word, index) => {
    el(`stepWord${index + 1}`).textContent = word;
  });

  reset();
}

// ---------- intake ----------

async function intake(file) {
  clearAlert();

  const VALIDATE = { image: validateImage, video: validateVideo, link: validateForLink };
  const DESCRIBE = { image: describeImage, video: describeVideo, link: describeForLink };

  try {
    VALIDATE[mode](file);
  } catch (err) {
    showAlert(err.message);
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
  updateNote();
}

// ---------- compressão ----------

async function run() {
  clearAlert();
  show('work');
  el('workLabel').textContent = 'A comprimir';
  el('trackFill').style.width = '0%';

  const q = Number(quality.value);

  try {
    if (mode === 'link') {
      el('workLabel').textContent = 'A enviar';
      const url = await uploadFile(sourceFile, (p) => {
        el('workLabel').textContent = `A enviar · ${Math.round(p * 100)}%`;
        el('trackFill').style.width = `${p * 100}%`;
      });
      el('linkOut').value = url;
      el('linkExpiry').textContent = 'O link é permanente. Quem tiver o endereço consegue abrir o ficheiro.';
      show('link');
      return;
    }

    if (mode === 'image') {
      el('trackFill').style.width = '60%';
      resultBlob = await compressImage(sourceFile, q, el('format').value);
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
    showAlert(err.message);
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
  document.querySelector('.verdict-word').textContent = saved >= 0 ? 'mais leve' : 'mais pesado';

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
  el('linkOut').value = '';
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
el('compressBtn').addEventListener('click', run);
el('swapBtn').addEventListener('click', reset);
el('againBtn').addEventListener('click', reset);
el('downloadBtn').addEventListener('click', download);
el('againLinkBtn').addEventListener('click', reset);

el('copyBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(el('linkOut').value);
  el('copyBtn').textContent = 'Copiado';
  setTimeout(() => { el('copyBtn').textContent = 'Copiar'; }, 1600);
});

quality.dispatchEvent(new Event('input'));
setMode('image');
