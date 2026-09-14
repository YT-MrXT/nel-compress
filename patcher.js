// ---------------------------------------------------------------------------
// PATCHER: interpolação de frames com Framegen (WebGPU)
// ---------------------------------------------------------------------------
// Substitui o ONNX Runtime + RIFE-lite. O ganho não vem só do modelo ser mais
// pequeno (2.9 MB contra 30 MB): vem de os cálculos serem kernels WebGPU
// escritos à mão, sem a camada genérica de um framework de ML pelo meio.
//
// Isto NÃO é compressão. Gera frames que não existiam, para dobrar a fluidez
// do movimento. O ficheiro de saída fica normalmente maior que o original.
//
// Requisitos duros, sem alternativa lenta: WebGPU com shader-f16. Na prática,
// Chrome/Edge 121+ com placa gráfica. Sem isso, falha com uma mensagem clara.

import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS,
  CanvasSource,
  VideoSampleSink,
  QUALITY_HIGH,
} from 'https://esm.sh/mediabunny@1.56.2';

const FRAMEGEN = 'https://cdn.jsdelivr.net/npm/framegen@1.4.0';

// O runtime exige lados múltiplos de 16. Acima de 1080 no lado curto o custo
// dispara sem ganho visível, porque o modelo não foi treinado para mais.
const MAX_SHORT_SIDE = 1080;
const round16 = (n) => Math.max(16, Math.round(n / 16) * 16);

export const patcherMode = {
  label: 'Patcher (interpolação de frames)',
  warning:
    'Isto gera frames novos com IA para dobrar o fps. Não é compressão — o ficheiro ' +
    'final costuma ficar maior. Precisa de Chrome ou Edge com placa gráfica.',
};

async function getDevice() {
  if (!('gpu' in navigator)) {
    throw new Error('Este browser não tem WebGPU. Usa o Chrome ou o Edge no computador.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('Não foi encontrada nenhuma placa gráfica acessível ao browser.');
  }

  if (!adapter.features.has('shader-f16')) {
    throw new Error('A tua placa gráfica não suporta shader-f16, que este modelo exige.');
  }

  return adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
}

async function createRuntime(outW, outH, onStatus) {
  onStatus?.('a preparar a placa gráfica…');
  const device = await getDevice();

  onStatus?.('a carregar o modelo (2.9 MB)…');
  const [{ createRT }, weightsBin, weightsManifest] = await Promise.all([
    import(`${FRAMEGEN}/rt.js`),
    fetch(`${FRAMEGEN}/weights/rt_v7s.bin`).then((r) => r.arrayBuffer()),
    fetch(`${FRAMEGEN}/weights/rt_v7s.json`).then((r) => r.json()),
  ]);

  return createRT(device, { w: outW, h: outH, weightsBin, weightsManifest });
}

// Desenha um frame descodificado no canvas de saída e devolve os píxeis em
// bruto, que é o formato que o runtime aceita.
function toRgba(sample, canvas, ctx) {
  sample.draw(ctx, 0, 0, canvas.width, canvas.height);
  return new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
}

export async function patchVideo(file, meta, { onProgress, onStatus }) {
  // Ao contrário do modelo anterior, este aceita qualquer proporção. Vídeo
  // vertical deixa de ser espremido numa caixa horizontal.
  const shrink = Math.min(1, MAX_SHORT_SIDE / Math.min(meta.width, meta.height));
  const outW = round16(meta.width * shrink);
  const outH = round16(meta.height * shrink);

  const rt = await createRuntime(outW, outH, onStatus);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('Não foi possível encontrar uma faixa de vídeo neste ficheiro.');
  if (!(await videoTrack.canDecode())) {
    throw new Error('Este browser não consegue descodificar este vídeo (codec não suportado).');
  }

  const duration = await input.computeDuration();

  // O fps nominal não é exposto pelo browser, por isso conta-se quantos frames
  // reais existem no primeiro segundo do próprio vídeo.
  let sourceFps = 30;
  {
    const probe = new VideoSampleSink(videoTrack);
    let count = 0;
    for await (const s of probe.samples(0, Math.min(1, duration))) {
      count++;
      s.close();
    }
    if (count > 0) sourceFps = count / Math.min(1, duration);
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const canvasSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(canvasSource);
  await output.start();

  const sink = new VideoSampleSink(videoTrack);
  const frameDuration = 1 / (sourceFps * 2);
  const estimatedTotal = Math.max(Math.round(duration * sourceFps), 1);

  let prevRgba = null;
  let outTimestamp = 0;
  let frameIndex = 0;

  for await (const sample of sink.samples()) {
    const rgba = toRgba(sample, canvas, ctx);
    sample.close();

    if (prevRgba) {
      // O frame real anterior já está desenhado quando o escrevemos abaixo,
      // por isso reordena-se: primeiro o anterior, depois o sintético.
      ctx.putImageData(new ImageData(new Uint8ClampedArray(prevRgba), outW, outH), 0, 0);
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      onStatus?.(`a gerar frame ${frameIndex} de ~${estimatedTotal}`);
      const mid = await rt.run(prevRgba, rgba, 0.5);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(mid), outW, outH), 0, 0);
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      onProgress?.(Math.min(frameIndex / estimatedTotal, 1));
    }

    prevRgba = rgba;
    frameIndex++;
  }

  // Último frame real, sem par seguinte para interpolar.
  if (prevRgba) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(prevRgba), outW, outH), 0, 0);
    await canvasSource.add(outTimestamp, frameDuration);
  }

  rt.destroy();
  await output.finalize();

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
