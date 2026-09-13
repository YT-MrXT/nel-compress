// O ffmpeg compilado para WebAssembly corre o codificador por software e é
// dezenas de vezes mais lento que o nativo. Isto usa o codificador de vídeo do
// próprio dispositivo, através da API WebCodecs, e é ordens de grandeza mais rápido.
import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  Conversion,
  ALL_FORMATS,
  Quality,
  canEncodeVideo,
} from 'https://esm.sh/mediabunny@1.56.2';

export const videoMode = {
  accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
  pageTitle: 'Comprimir vídeo',
  heading: 'Escolhe o teu vídeo',
  formats: 'MP4, MOV, WebM e MKV são suportados.',
  selectLabel: 'Selecionar vídeo',
  note: '',
  lede: 'Escolhe um vídeo, define a qualidade, a resolução e os fps, e transfere o resultado.',
  setupHeading: 'Define a qualidade',
  setupSub: 'Menos resolução e menos fps dão um ficheiro mais pequeno e uma conversão mais rápida.',
  steps: ['Ficheiro', 'Qualidade', 'Transferir'],
  action: 'Comprimir',
};

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];

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

// O quantizer é o equivalente ao CRF: valores baixos dão mais qualidade. Usar
// um número em vez de quatro níveis fixos faz o slider todo contar. O bitrate
// serve de reserva caso o codificador do dispositivo não aceite o quantizer.
function qualityFor(meta, settings) {
  const quantizer = Math.round(40 - ((settings.quality - 10) / 85) * 22);

  const shortSide = settings.shortSide === 'source'
    ? Math.min(meta.width, meta.height)
    : Math.min(Number(settings.shortSide), Math.min(meta.width, meta.height));
  const aspect = Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height);
  const fps = settings.fps === 'source' ? 30 : Number(settings.fps);
  const pixels = shortSide * shortSide * aspect;

  const bitrate = Math.max(Math.round(pixels * fps * 0.08 * (settings.quality / 70)), 300000);

  return new Quality({ quantizer, bitrate });
}

// A resolução é escolhida pelo lado mais curto, para tratar retrato e paisagem
// da mesma maneira. Passa-se só uma dimensão: a outra é deduzida pelo rácio.
// Dar as duas obrigaria a definir também o 'fit'. Nunca aumenta um vídeo pequeno.
function targetSize(meta, shortSide) {
  if (shortSide === 'source') return {};

  const target = Number(shortSide);
  if (target >= Math.min(meta.width, meta.height)) return {};

  return meta.height > meta.width ? { width: target } : { height: target };
}

export async function compressVideo(file, meta, settings, { onLoadProgress, onProgress }) {
  onLoadProgress();

  if (!(await canEncodeVideo('avc'))) {
    throw new Error('Este browser não consegue codificar H.264. Experimenta o Chrome ou o Edge.');
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const conversion = await Conversion.init({
    input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
    output,
    video: {
      codec: 'avc',
      quality: qualityFor(meta, settings),
      hardwareAcceleration: 'prefer-hardware',
      ...targetSize(meta, settings.shortSide),
      ...(settings.fps === 'source' ? {} : { frameRate: Number(settings.fps) }),
      forceTranscode: true,
    },
    audio: { codec: 'aac', bitrate: 128000 },
  });

  conversion.onProgress = (progress) => onProgress(Math.min(progress, 1));
  await conversion.execute();

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
