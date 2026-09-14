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
  VideoSampleSource,
  VideoSample,
  VideoSampleSink,
  EncodedPacketSink,
  EncodedAudioPacketSource,
  QUALITY_HIGH,
  QUALITY_LOW,
  canEncodeVideo,
} from 'https://esm.sh/mediabunny@1.56.2';

const FRAMEGEN = 'https://cdn.jsdelivr.net/npm/framegen@1.4.0';

// O runtime exige lados múltiplos de 16.
const round16 = (n) => Math.max(16, Math.round(n / 16) * 16);

// O custo cresce com o número de píxeis, por isso a resolução é o travão
// principal. Serve para estimar quanto tempo cada método vai levar.
export function pixelCost(meta, shortSide) {
  const shrink = Math.min(1, shortSide / Math.min(meta.width, meta.height));
  return round16(meta.width * shrink) * round16(meta.height * shrink);
}

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
// A cópia entre texturas é gravada num codificador de comandos e só depois
// submetida à fila. A fila em si não tem este método.
function copyTexture(device, from, to, width, height) {
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture({ texture: from }, { texture: to }, [width, height]);
  device.queue.submit([encoder.finish()]);
}

function sampleToTexture(sample, device, scaleCanvas, scaleCtx, texture) {
  sample.draw(scaleCtx, 0, 0, scaleCanvas.width, scaleCanvas.height);
  device.queue.copyExternalImageToTexture(
    { source: scaleCanvas },
    { texture },
    [scaleCanvas.width, scaleCanvas.height]
  );
}

export async function patchVideo(file, meta, settings) {
  const { shortSide, targetFps, smaller, onProgress, onStatus } = settings;

  // Este modelo aceita qualquer proporção, ao contrário do anterior: vídeo
  // vertical deixa de ser espremido numa caixa horizontal.
  const shrink = shortSide === 'source'
    ? 1
    : Math.min(1, Number(shortSide) / Math.min(meta.width, meta.height));
  const outW = round16(meta.width * shrink);
  const outH = round16(meta.height * shrink);

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

  // Se o destino não for acima do que o vídeo já tem, não há nada para
  // inventar: salta-se o modelo inteiro e o trabalho reduz-se a recodificar.
  const wantFps = targetFps === 'double' ? sourceFps * 2 : Number(targetFps);
  const interpolate = wantFps > sourceFps + 0.5;

  const gpu = interpolate ? await createRuntime(outW, outH, onStatus) : null;
  const device = gpu?.device ?? null;
  const rt = gpu?.rt ?? null;

  // Canvas 2D para redimensionar. Sem interpolação é ele a alimentar o
  // codificador diretamente, e nem chega a existir contexto WebGPU.
  const scaleCanvas = document.createElement('canvas');
  scaleCanvas.width = outW;
  scaleCanvas.height = outH;
  const scaleCtx = scaleCanvas.getContext('2d');

  let outCanvas = scaleCanvas;
  let gpuCtx = null;
  let texPrev = null;
  let texCur = null;

  if (interpolate) {
    outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    gpuCtx = outCanvas.getContext('webgpu');
    gpuCtx.configure({
      device,
      format: 'rgba8unorm',
      alphaMode: 'opaque',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const makeFrameTexture = () => device.createTexture({
      size: [outW, outH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    texPrev = makeFrameTexture();
    texCur = makeFrameTexture();
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  // VideoSampleSource em vez de CanvasSource: assim a captura do frame fica
  // separada da espera pelo codificador, e cada uma pode ser cronometrada.
  //
  // Pedir 'prefer-hardware' às cegas faz a configuração ser rejeitada quando a
  // resolução é pequena demais para o codificador da placa gráfica. Por isso
  // pergunta-se primeiro, com a resolução real deste vídeo, e só se pede
  // hardware quando a resposta é sim.
  const quality = smaller ? QUALITY_LOW : QUALITY_HIGH;
  const hardwarePossivel = await canEncodeVideo('avc', {
    width: outW,
    height: outH,
    quality,
    hardwareAcceleration: 'prefer-hardware',
  });

  const encoderInfo = hardwarePossivel ? 'hardware' : 'software';
  const sampleSource = new VideoSampleSource({
    codec: 'avc',
    bitrate: quality,
    latencyMode: 'realtime',
    ...(hardwarePossivel ? { hardwareAcceleration: 'prefer-hardware' } : {}),
  });
  output.addVideoTrack(sampleSource);

  // O áudio é copiado pacote a pacote, sem passar por descodificador nenhum.
  // Como a duração total do vídeo não muda (dobram-se os frames mas cada um
  // dura metade), os tempos do som continuam a bater certo com a imagem.
  const audioTrack = await input.getPrimaryAudioTrack();
  let audioSource = null;
  let audioConfig = null;

  if (audioTrack) {
    const audioCodec = await audioTrack.getCodec();
    audioConfig = await audioTrack.getDecoderConfig();

    if (audioCodec && audioConfig) {
      audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioSource);
    }
  }

  await output.start();

  if (audioSource) {
    const packetSink = new EncodedPacketSink(audioTrack);
    let first = true;
    for await (const packet of packetSink.packets()) {
      // A configuração do descodificador só vai no primeiro pacote.
      await audioSource.add(packet, first ? { decoderConfig: audioConfig } : undefined);
      first = false;
    }
  }

  const sink = new VideoSampleSink(videoTrack);
  const frameDuration = 1 / (interpolate ? sourceFps * 2 : sourceFps);
  const estimatedTotal = Math.max(Math.round(duration * sourceFps), 1);

  let hasPrev = false;
  let outTimestamp = 0;
  let frameIndex = 0;
  const startedAt = performance.now();

  // Medir cada etapa em separado. Sem isto não há como saber se o tempo está
  // a ser gasto a descodificar o vídeo, a passar pelo modelo, ou a codificar.
  let tDescodificar = 0;
  let tModelo = 0;
  let tCapturar = 0;
  let tCodificar = 0;

  // Capturar o canvas e entregar ao codificador, medindo cada parte.
  const gravar = async (timestamp, duration) => {
    const tA = performance.now();
    const frame = new VideoSample(outCanvas, { timestamp, duration });
    tCapturar += performance.now() - tA;

    const tB = performance.now();
    await sampleSource.add(frame);
    tCodificar += performance.now() - tB;
    frame.close();
  };

  const relatar = () => {
    const n = Math.max(frameIndex, 1);
    const elapsed = (performance.now() - startedAt) / 1000;
    const perFrame = elapsed / n;
    const remaining = Math.round(perFrame * (estimatedTotal - frameIndex));
    const ms = (total) => (total / n).toFixed(0);

    onStatus?.(
      `frame ${frameIndex}/${estimatedTotal} · ${(perFrame * 1000).toFixed(0)} ms ` +
      `(descodificar ${ms(tDescodificar)} · modelo ${ms(tModelo)} · capturar ${ms(tCapturar)} · codificar ${ms(tCodificar)}) ` +
      `· faltam ~${remaining}s · ${encoderInfo}`
    );
    onProgress?.(Math.min(frameIndex / estimatedTotal, 1));
  };

  const iterador = sink.samples()[Symbol.asyncIterator]();

  while (true) {
    const t0 = performance.now();
    const passo = await iterador.next();
    tDescodificar += performance.now() - t0;
    if (passo.done) break;
    const sample = passo.value;

    if (!interpolate) {
      // Sem frames a inventar: desenhar e gravar, um por um.
      sample.draw(scaleCtx, 0, 0, outW, outH);
      sample.close();
      await gravar(outTimestamp, frameDuration);
      outTimestamp += frameDuration;
      frameIndex++;
      relatar();
      continue;
    }

    const tPrep = performance.now();
    sampleToTexture(sample, device, scaleCanvas, scaleCtx, texCur);
    sample.close();
    tModelo += performance.now() - tPrep;

    if (hasPrev) {
      // 1) frame real anterior
      copyTexture(device, texPrev, gpuCtx.getCurrentTexture(), outW, outH);
      await gravar(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      // 2) frame sintético, escrito pelo modelo diretamente no canvas
      const t2 = performance.now();
      rt.prepPair(texPrev, texCur);
      rt.runT(0.5, gpuCtx.getCurrentTexture());
      tModelo += performance.now() - t2;

      await gravar(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      relatar();
    }

    [texPrev, texCur] = [texCur, texPrev];
    hasPrev = true;
    frameIndex++;
  }

  // Último frame real, que não tem par seguinte para interpolar.
  if (interpolate && hasPrev) {
    copyTexture(device, texPrev, gpuCtx.getCurrentTexture(), outW, outH);
    await gravar(outTimestamp, frameDuration);
  }

  texPrev?.destroy();
  texCur?.destroy();
  rt?.destroy();
  await output.finalize();

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
