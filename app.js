import { imageMode, validateImage, describeImage, compressImage } from './image.js';
import { videoMode, validateVideo, describeVideo, compressVideo } from './video.js';

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
};

let mode = 'image';
let sourceFile = null;
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

function currentMode() {
  return mode === 'image' ? imageMode : videoMode;
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
  el('dropHeading').textContent = config.heading;
  el('dropSub').textContent = config.formats;
  el('dropTitle').textContent = config.selectLabel;
  el('setupNote').textContent = config.note;

  reset();
}

// ---------- intake ----------

async function intake(file) {
  clearAlert();

  try {
    if (mode === 'image') validateImage(file);
    else validateVideo(file);
  } catch (err) {
    showAlert(err.message);
    return;
  }

  sourceFile = file;
  el('fileName').textContent = file.name;
  el('thumb').style.backgroundImage =
    mode === 'image' ? `url(${URL.createObjectURL(file)})` : 'none';

  show('setup');

  const dimensions = mode === 'image' ? await describeImage(file) : await describeVideo(file);
  el('fileSub').textContent = `${dimensions} · ${formatBytes(file.size)}`;
}

// ---------- compressão ----------

async function run() {
  clearAlert();
  show('work');
  el('workLabel').textContent = 'A comprimir';
  el('trackFill').style.width = '0%';

  const q = Number(quality.value);

  try {
    if (mode === 'image') {
      el('trackFill').style.width = '60%';
      resultBlob = await compressImage(sourceFile, q);
    } else {
      resultBlob = await compressVideo(sourceFile, q, {
        onLoadProgress: () => {
          el('workLabel').textContent = 'A carregar o motor de vídeo';
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

  el('verdictNum').textContent = `${saved}%`;
  document.querySelector('.verdict-word').textContent = saved >= 0 ? 'mais leve' : 'mais pesado';

  el('sizeBefore').textContent = formatBytes(before);
  el('sizeAfter').textContent = formatBytes(after);
  el('barBefore').style.setProperty('--w', 1);
  el('barAfter').style.setProperty('--w', Math.max(after / before, 0.02));

  show('done');
}

function download() {
  const baseName = sourceFile.name.replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(resultBlob);
  link.download = `${baseName}-featherweight.${currentMode().extension}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function reset() {
  sourceFile = null;
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

el('compressBtn').addEventListener('click', run);
el('swapBtn').addEventListener('click', reset);
el('againBtn').addEventListener('click', reset);
el('downloadBtn').addEventListener('click', download);

quality.dispatchEvent(new Event('input'));
setMode('image');
