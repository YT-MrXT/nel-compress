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
        duration: probe.duration,
      });
      URL.revokeObjectURL(probe.src);
    };
    probe.onerror = () => reject(new Error('Não foi possível ler os metadados deste vídeo.'));
    probe.src = URL.createObjectURL(file);
  });
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

// O quantizer é o equivalente ao CRF: valores baixos dão mais qualidade. Usar
// um número em vez de quatro níveis fixos faz o slider todo contar.
//
// O bitrate-alvo é a parte que decide o tamanho do ficheiro. Em vez de o
// calcular só a partir de pixels/fps/qualidade (o que pode facilmente pedir
// mais bitrate do que o vídeo original já tem, sobretudo em ficheiros já bem
// comprimidos em H.265/AV1), ele é sempre ancorado ao bitrate real do
// ficheiro de origem: no máximo um "orçamento" que garante compressão real
// mesmo com resolução e fps mantidos exatamente iguais aos escolhidos.
function qualityFor(meta, settings, bitrateBudget) {
  const quantizer = Math.max(Math.round(40 - ((settings.quality - 10) / 90) * 22), 18);

  const shortSide = settings.shortSide === 'source'
    ? Math.min(meta.width, meta.height)
    : Math.min(Number(settings.shortSide), Math.min(meta.width, meta.height));
  const aspect = Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height);
  const fps = settings.fps === 'source' ? 30 : Number(settings.fps);
  const pixels = shortSide * shortSide * aspect;

  // Bitrate "desejado" com base na resolução/fps/qualidade finais.
  const qualityFactor = Math.min(settings.quality / 70, 1);
  const desiredBitrate = Math.round(pixels * fps * 0.07 * qualityFactor);

  const bitrate = Math.max(Math.min(desiredBitrate, bitrateBudget ?? Infinity), 200000);

  return new Quality({ quantizer, bitrate });
}

async function encodeAttempt(file, meta, settings, bitrateBudget, hardwareAcceleration, onProgress) {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const conversion = await Conversion.init({
    input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
    output,
    video: {
      codec: 'avc',
      quality: qualityFor(meta, settings, bitrateBudget),
      hardwareAcceleration,
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

// Alguns dispositivos/browsers anunciam suporte a codificação por hardware
// (via canEncodeVideo) mas depois recusam combinações específicas de
// parâmetros (resolução, bitrate, quantizer) em tempo de execução. Em vez de
// falhar logo, tenta primeiro com preferência por hardware (mais rápido) e,
// se essa combinação exata for rejeitada, repete a mesma tentativa forçando
// software — sem hardware não há esse tipo de limitação de configuração.
async function encodeWithFallback(file, meta, settings, bitrateBudget, onProgress) {
  try {
    return await encodeAttempt(file, meta, settings, bitrateBudget, 'prefer-hardware', onProgress);
  } catch (err) {
    if (/not supported in this environment/i.test(err.message)) {
      return await encodeAttempt(file, meta, settings, bitrateBudget, 'prefer-software', onProgress);
    }
    throw err;
  }
}

export async function compressVideo(file, meta, settings, { onLoadProgress, onProgress }) {
  onLoadProgress();

  if (!(await canEncodeVideo('avc'))) {
    throw new Error('Este browser não consegue codificar H.264. Experimenta o Chrome ou o Edge.');
  }

  // Bitrate real do ficheiro de origem, usado para ancorar o bitrate-alvo da
  // primeira tentativa: garante compressão real independentemente da
  // resolução/fps escolhidas, sem nunca as alterar por trás das costas da
  // pessoa. Qualidade 100 mira ~85% do bitrate de origem (compressão real
  // mas quase transparente); qualidades mais baixas miram frações menores.
  const sourceBitrate = meta.duration ? Math.round((file.size * 8) / meta.duration) : null;
  const initialBudget = sourceBitrate
    ? Math.round(sourceBitrate * (0.35 + 0.5 * (settings.quality / 100)))
    : null;

  let result = await encodeWithFallback(file, meta, settings, initialBudget, onProgress);

  // Se, ainda assim, o resultado não ficar mais leve (pode acontecer com
  // ficheiros já extremamente comprimidos), volta a tentar com um bitrate-alvo
  // cada vez mais apertado — mantendo sempre a resolução e os fps exatamente
  // como a pessoa escolheu, nunca os reduzindo escondido.
  if (result.size >= file.size && sourceBitrate) {
    for (const budgetFactor of [0.5, 0.3, 0.15]) {
      const candidate = await encodeWithFallback(
        file,
        meta,
        settings,
        Math.round(sourceBitrate * budgetFactor),
        onProgress
      );
      if (candidate.size < result.size) result = candidate;
      if (result.size < file.size) break;
    }
  }

  return result;
}
