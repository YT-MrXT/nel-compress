// ---------------------------------------------------------------------------
// PATCHER: interpolação de frames com Framegen (WebGPU)
// ---------------------------------------------------------------------------
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

// O runtime exige lados múltiplos de 16.
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

  // Estes pesos ("tfact") só funcionam em modo de texturas: o runtime recusa
  // o modo de buffers. É também o modo rápido — os píxeis ficam na GPU.
  const rt = await createRT(device, {
    w: outW, h: outH, weightsBin, weightsManifest,
    textureInput: true,
    textureOutput: true,
  });

  return { rt, device };
}

// O frame chega no tamanho original e o modelo trabalha noutro, por isso passa
// primeiro por um canvas 2D que o redimensiona. A cópia para a textura é feita
// pela GPU: os píxeis nunca chegam a ser lidos para a memória do processador.
function sampleToTexture(sample, device, scaleCanvas, scaleCtx, texture) {
  sample.draw(scaleCtx, 0, 0, scaleCanvas.width, scaleCanvas.height);
  device.queue.copyExternalImageToTexture(
    { source: scaleCanvas },
    { texture },
    [scaleCanvas.width, scaleCanvas.height]
  );
}

export async function patchVideo(file, meta, { onProgress, onStatus }) {
  // Ao contrário do modelo anterior, este aceita qualquer proporção. Vídeo
  // vertical deixa de ser espremido numa caixa horizontal.
  const shrink = Math.min(1, MAX_SHORT_SIDE / Math.min(meta.width, meta.height));
  const outW = round16(meta.width * shrink);
  const outH = round16(meta.height * shrink);

  const { rt, device } = await createRuntime(outW, outH, onStatus);

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

  // Canvas 2D só para redimensionar; nunca se lêem píxeis dele.
  const scaleCanvas = document.createElement('canvas');
  scaleCanvas.width = outW;
  scaleCanvas.height = outH;
  const scaleCtx = scaleCanvas.getContext('2d');

  // Canvas WebGPU: é daqui que o codificador tira cada frame, e é aqui que o
  // runtime escreve os frames sintéticos, sem passarem pelo processador.
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const gpuCtx = outCanvas.getContext('webgpu');
  gpuCtx.configure({
    device,
    format: 'rgba8unorm',
    alphaMode: 'opaque',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const makeFrameTexture = () => device.createTexture({
    size: [outW, outH],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  let texPrev = makeFrameTexture();
  let texCur = makeFrameTexture();

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const canvasSource = new CanvasSource(outCanvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(canvasSource);
  await output.start();

  const sink = new VideoSampleSink(videoTrack);
  const frameDuration = 1 / (sourceFps * 2);
  const estimatedTotal = Math.max(Math.round(duration * sourceFps), 1);

  let hasPrev = false;
  let outTimestamp = 0;
  let frameIndex = 0;

  for await (const sample of sink.samples()) {
    sampleToTexture(sample, device, scaleCanvas, scaleCtx, texCur);

    if (hasPrev) {
      // 1) frame real anterior, copiado para o canvas de saída
      device.queue.copyTextureToTexture(
        { texture: texPrev }, { texture: gpuCtx.getCurrentTexture() }, [outW, outH]
      );
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      // 2) frame sintético, escrito diretamente no canvas pelo runtime
      onStatus?.(`a gerar frame ${frameIndex} de ~${estimatedTotal}`);
      rt.prepPair(texPrev, texCur);
      rt.runT(0.5, gpuCtx.getCurrentTexture());
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      onProgress?.(Math.min(frameIndex / estimatedTotal, 1));
    }

    sample.close();
    [texPrev, texCur] = [texCur, texPrev];
    hasPrev = true;
    frameIndex++;
  }

  // Último frame real, sem par seguinte para interpolar.
  if (hasPrev) {
    device.queue.copyTextureToTexture(
      { texture: texPrev }, { texture: gpuCtx.getCurrentTexture() }, [outW, outH]
    );
    await canvasSource.add(outTimestamp, frameDuration);
  }

  texPrev.destroy();
  texCur.destroy();
  rt.destroy();
  await output.finalize();

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
