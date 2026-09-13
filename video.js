import { FFmpeg } from 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
import { fetchFile, toBlobURL } from 'https://esm.sh/@ffmpeg/util@0.12.1';

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

export const videoMode = {
  accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
  extension: 'mp4',
  pageTitle: 'Comprimir vídeo',
  heading: 'Escolhe o teu vídeo',
  formats: 'MP4, MOV, WebM e MKV são suportados.',
  selectLabel: 'Selecionar vídeo',
  note: 'Da primeira vez, o motor de vídeo (~30 MB) é descarregado antes de começar.',
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
      resolve(`${probe.videoWidth} × ${probe.videoHeight} · ${minutes}:${seconds}`);
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

async function loadFfmpeg(onLoadProgress) {
  if (ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();
  onLoadProgress();

  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  return ffmpeg;
}

export async function compressVideo(file, quality, { onLoadProgress, onProgress }) {
  const engine = await loadFfmpeg(onLoadProgress);

  engine.on('progress', ({ progress }) => onProgress(Math.min(progress, 1)));

  await engine.writeFile('input', await fetchFile(file));
  await engine.exec([
    '-i', 'input',
    '-c:v', 'libx264',
    '-crf', String(qualityToCrf(quality)),
    '-preset', 'veryfast',
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
