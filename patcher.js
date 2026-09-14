// ---------------------------------------------------------------------------
// PATCHER: interpolação de frames com RIFE (ONNX Runtime Web)
// ---------------------------------------------------------------------------
// Isto NÃO é compressão. Faz o oposto: gera frames novos (sintéticos, gerados
// por um modelo de fluxo ótico) entre os frames reais, para dobrar o fps
// aparente de movimento. O ficheiro de saída fica normalmente MAIOR que o
// original, nunca mais pequeno. Está isolado do resto do nel-compress de
// propósito — não altera nada do fluxo normal de compressão.
//
// Requisitos:
//   - rife425_lite.onnx + rife425_lite.onnx.data (mesma pasta, sempre juntos)
//   - onnxruntime-web (carregado via CDN abaixo)
//   - Um browser com WebCodecs (Chrome/Edge desktop; suporte móvel é limitado)
//
// Isto é LENTO. Em CPU/WASM puro, cada frame gerado pode demorar
// 1-5 segundos. Um vídeo de 10s a 30fps tem ~300 frames a interpolar =
// 5-25 minutos. Não há atalho para isto sem GPU (WebGPU ajuda mas nem todos
// os browsers/dispositivos o suportam bem para ONNX ainda).
//
// API do mediabunny usada aqui (confirmada em mediabunny.dev/api):
//   - VideoSampleSink(videoTrack).samples() -> AsyncGenerator<VideoSample>
//   - sample.draw(ctx, x, y) desenha o frame decodificado num canvas 2D
//   - sample.close() liberta os recursos do frame (obrigatório, tal como
//     VideoFrame.close())
//   - CanvasSource(canvas, { codec, bitrate }).add(timestamp, duration)
//     captura o estado atual do canvas como um frame de saída

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

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs')
      .then((mod) => {
        mod.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        // Desativa threads WASM de propósito: threads exigem SharedArrayBuffer,
        // que por sua vez exige cross-origin isolation (COOP/COEP) em todo o
        // site, incluindo CDNs de terceiros com cabeçalhos CORP corretos —
        // frágil e difícil de garantir. Single-thread é mais lento mas
        // funciona em qualquer hospedagem sem configuração extra.
        mod.env.wasm.numThreads = 1;
        return mod;
      });
  }
  return ortPromise;
}

// O modelo foi exportado para aceitar exatamente esta resolução (ver
// export_onnx.py --height 480 --width 896). Frames de outro tamanho são
// reamostrados (letterbox) para esta caixa e depois recortados de volta.
const MODEL_H = 512;
const MODEL_W = 896;

export const patcherMode = {
  label: 'Patcher (interpolação de frames)',
  warning:
    'Isto gera frames novos com IA para dobrar o fps aparente. Não é compressão — ' +
    'o ficheiro final costuma ficar maior, não mais pequeno, e o processo é lento ' +
    '(minutos, não segundos, dependendo da duração do vídeo).',
};

// 113 dos 185 pesos deste modelo vivem num ficheiro separado (.onnx.data). O
// ONNX Runtime não o descobre sozinho a partir de um URL: é preciso indicá-lo.
// O 'path' tem de ser exatamente a string que o .onnx referencia internamente.
const WEIGHTS_FILE = 'rife425_lite.onnx.data';

async function createSession(onnxUrl) {
  const ort = await loadOrt();
  const weightsUrl = new URL(WEIGHTS_FILE, new URL(onnxUrl, location.href)).href;

  return ort.InferenceSession.create(onnxUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: WEIGHTS_FILE, data: weightsUrl }],
  });
}

// Desenha um VideoSample num canvas na resolução do modelo (letterbox, sem
// distorcer o aspect ratio original) e devolve o ImageData + a caixa usada,
// para depois se poder desfazer o letterbox na saída.
function sampleToModelInput(sample, canvas, ctx) {
  canvas.width = MODEL_W;
  canvas.height = MODEL_H;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, MODEL_W, MODEL_H);

  const srcW = sample.displayWidth ?? sample.codedWidth;
  const srcH = sample.displayHeight ?? sample.codedHeight;
  const scale = Math.min(MODEL_W / srcW, MODEL_H / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const x = Math.floor((MODEL_W - w) / 2);
  const y = Math.floor((MODEL_H - h) / 2);

  sample.draw(ctx, x, y, w, h);
  return { imageData: ctx.getImageData(0, 0, MODEL_W, MODEL_H), box: { x, y, w, h } };
}

// HWC uint8 RGBA -> CHW float32 RGB [0,1], o formato que o grafo ONNX espera.
function imageDataToTensor(imageData, ort) {
  const { data, width, height } = imageData;
  const chw = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255;
    chw[plane + i] = data[i * 4 + 1] / 255;
    chw[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', chw, [1, 3, height, width]);
}

// Inverso: CHW float32 -> desenha no canvas de saída, recortando de volta a
// área real (desfazendo o letterbox) e esticando ao tamanho de saída.
function drawTensorCropped(tensor, box, outW, outH, canvas, ctx) {
  const [, , h, w] = tensor.dims;
  const data = tensor.data;
  const plane = w * h;
  const imageData = new ImageData(w, h);
  for (let i = 0; i < plane; i++) {
    imageData.data[i * 4] = Math.max(0, Math.min(255, data[i] * 255));
    imageData.data[i * 4 + 1] = Math.max(0, Math.min(255, data[plane + i] * 255));
    imageData.data[i * 4 + 2] = Math.max(0, Math.min(255, data[2 * plane + i] * 255));
    imageData.data[i * 4 + 3] = 255;
  }

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').putImageData(imageData, 0, 0);

  canvas.width = outW;
  canvas.height = outH;
  ctx.drawImage(tmp, box.x, box.y, box.w, box.h, 0, 0, outW, outH);
}

async function interpolateMidFrame(session, ort, sampleA, sampleB, tmpCanvas, tmpCtx, outCanvas, outCtx, outW, outH) {
  const inA = sampleToModelInput(sampleA, tmpCanvas, tmpCtx);
  const tA = imageDataToTensor(inA.imageData, ort);
  const inB = sampleToModelInput(sampleB, tmpCanvas, tmpCtx);
  const tB = imageDataToTensor(inB.imageData, ort);

  const results = await session.run({ img0: tA, img1: tB });
  drawTensorCropped(results.mid_frame, inA.box, outW, outH, outCanvas, outCtx);
}

// ---------------------------------------------------------------------------
// Pipeline principal: decodifica o vídeo frame a frame, insere um frame
// interpolado entre cada par consecutivo (dobra o fps), recodifica.
// ---------------------------------------------------------------------------
export async function patchVideo(file, meta, { onnxUrl, onProgress, onStatus }) {
  onStatus?.('a carregar o modelo…');
  let session, ort;
  try {
    [session, ort] = await Promise.all([createSession(onnxUrl), loadOrt()]);
  } catch (err) {
    throw new Error(
      typeof err === 'number'
        ? `O modelo não carregou (código interno ${err}). Confirma que ${WEIGHTS_FILE} está publicado ao lado do .onnx.`
        : `O modelo não carregou: ${err.message}`
    );
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('Não foi possível encontrar uma faixa de vídeo neste ficheiro.');

  const decodable = await videoTrack.canDecode();
  if (!decodable) throw new Error('Este browser não consegue descodificar este vídeo (codec não suportado).');

  const outW = meta.width;
  const outH = meta.height;

  const duration = await input.computeDuration();

  // Não há forma fiável de ler o fps "nominal" só com <video>/HTMLVideoElement
  // (o browser não expõe isso diretamente). Em vez de adivinhar, conta-se
  // quantos frames reais existem no primeiro segundo do próprio vídeo.
  let sourceFps = 30;
  {
    const probeSink = new VideoSampleSink(videoTrack);
    let count = 0;
    for await (const s of probeSink.samples(0, Math.min(1, duration))) {
      count++;
      s.close();
    }
    if (count > 0) sourceFps = count / Math.min(1, duration);
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d');

  const canvasSource = new CanvasSource(outCanvas, { codec: 'avc', bitrate: QUALITY_HIGH });
  output.addVideoTrack(canvasSource);
  await output.start();

  const tmpCanvas = document.createElement('canvas');
  const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

  const sink = new VideoSampleSink(videoTrack);

  let prevSample = null;
  let outTimestamp = 0;
  const frameDuration = 1 / (sourceFps * 2);
  let frameIndex = 0;
  // Estimativa grosseira do total de frames, só para a barra de progresso.
  const estimatedTotal = Math.max(Math.round(duration * sourceFps), 1);

  for await (const sample of sink.samples()) {
    if (prevSample) {
      // 1) frame real anterior
      prevSample.draw(outCtx, 0, 0, outW, outH);
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      // 2) frame sintético a meio caminho entre o anterior e o atual
      onStatus?.(`a gerar frame ${frameIndex + 1} de ~${estimatedTotal}…`);
      await interpolateMidFrame(session, ort, prevSample, sample, tmpCanvas, tmpCtx, outCanvas, outCtx, outW, outH);
      await canvasSource.add(outTimestamp, frameDuration);
      outTimestamp += frameDuration;

      onProgress?.(Math.min(frameIndex / estimatedTotal, 1));
      prevSample.close();
    }
    prevSample = sample;
    frameIndex++;
  }

  // Último frame real, sem par seguinte para interpolar.
  if (prevSample) {
    prevSample.draw(outCtx, 0, 0, outW, outH);
    await canvasSource.add(outTimestamp, frameDuration);
    prevSample.close();
  }

  await output.finalize();
  onProgress?.(1);
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}
