import { FFmpeg } from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { fetchFile, toBlobURL } from 'https://esm.sh/@ffmpeg/util@0.12.1';

// Build multi-thread: usa vários núcleos do processador. Exige que a página
// esteja cross-origin isolated (ver o ficheiro _headers).
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';

// O Worker não pode ser construído a partir de um URL noutra origem, por isso
// é servido de um blob, que conta como mesma origem.
const CLASS_WORKER_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';

export const videoMode = {
  accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
  extension: 'mp4',
  pageTitle: 'Comprimir vídeo',
  heading: 'Escolhe o teu vídeo',
  formats: 'MP4, MOV, WebM e MKV são suportados.',
  selectLabel: 'Selecionar vídeo',
  note: 'Da primeira vez, o motor de vídeo (~30 MB) é descarregado antes de começar.',
  steps: ['Ficheiro', 'Qualidade', 'Transferir'],
  action: 'Comprimir',
};

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];

let ffmpeg = null;

export function validateVideo(file) {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error(`${file.type || 'Este formato'} não é um vídeo suportado. Usa MP4, MOV, WebM ou MKV.`);
  }
}

export function describeVideo(file) {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const minutes = Math.floor(probe.duration / 60);
      const seconds = String(Math.floor(probe.duration % 60)).padStart(2, '0');
      resolve({
        label: `${probe.videoWidth} × ${probe.videoHeight} · ${minutes}:${seconds}`,
        width: probe.videoWidth,
        height: probe.videoHeight,
      });
      URL.revokeObjectURL(probe.src);
    };
    probe.onerror = () => reject(new Error('Não foi possível ler os metadados deste vídeo.'));
    probe.src = URL.createObjectURL(file);
  });
}

// A escala de qualidade 10–95 é mapeada para o CRF do x264 (baixo = melhor).
function qualityToCrf(quality) {
  return Math.round(40 - ((quality - 10) / 85) * 18);
}

// A resolução é escolhida pelo lado mais curto, para tratar retrato e paisagem
// da mesma maneira. O -2 deixa o ffmpeg calcular o outro lado mantendo o rácio.
function buildFilters(meta, shortSide, fps) {
  const filters = [];

  if (shortSide !== 'source' && Number(shortSide) < Math.min(meta.width, meta.height)) {
    filters.push(meta.height > meta.width ? `scale=${shortSide}:-2` : `scale=-2:${shortSide}`);
  }

  if (fps !== 'source') {
    filters.push(`fps=${fps}`);
  }

  return filters;
}

async function loadFfmpeg(onLoadProgress) {
  if (ffmpeg) return ffmpeg;

  if (!self.crossOriginIsolated) {
    throw new Error(
      'A página não está cross-origin isolated, por isso o motor multi-thread não pode arrancar. Confirma que o ficheiro _headers foi publicado.'
    );
  }

  ffmpeg = new FFmpeg();
  onLoadProgress();

  await ffmpeg.load({
    classWorkerURL: await toBlobURL(CLASS_WORKER_URL, 'text/javascript'),
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    // O core deriva este URL a partir do coreURL, o que não funciona quando o
    // coreURL é um blob. Tem de ser passado à mão.
    workerURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
  });

  return ffmpeg;
}

export async function compressVideo(file, meta, settings, { onLoadProgress, onProgress }) {
  const engine = await loadFfmpeg(onLoadProgress);

  engine.on('progress', ({ progress }) => onProgress(Math.min(progress, 1)));

  const filters = buildFilters(meta, settings.shortSide, settings.fps);

  await engine.writeFile('input', await fetchFile(file));
  await engine.exec([
    '-i', 'input',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264',
    '-crf', String(qualityToCrf(settings.quality)),
    '-preset', 'veryfast',
    '-threads', String(navigator.hardwareConcurrency || 4),
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    'output.mp4',
  ]);

  const data = await engine.readFile('output.mp4');
  await engine.deleteFile('input');
  await engine.deleteFile('output.mp4');

  return new Blob([data.buffer], { type: 'video/mp4' });
}
