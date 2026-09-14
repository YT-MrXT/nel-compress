export const imageMode = {
  accept: 'image/jpeg,image/png,image/webp',
  pageTitle: 'Comprimir imagem',
  heading: 'Escolhe a tua imagem',
  formats: 'JPG, PNG e WebP são suportados.',
  selectLabel: 'Selecionar imagem',
  note: '',
  lede: 'Escolhe uma imagem, define a qualidade e transfere o resultado.',
  setupHeading: 'Define a qualidade',
  setupSub: 'Menos qualidade, ficheiro mais pequeno. O melhor ponto costuma andar entre 60 e 80.',
  steps: ['Ficheiro', 'Qualidade', 'Transferir'],
  action: 'Comprimir',
};

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export function validateImage(file) {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error(`${file.type || 'Este formato'} não é uma imagem suportada. Usa JPG, PNG ou WebP.`);
  }
}

export async function describeImage(file) {
  const bitmap = await createImageBitmap(file);
  const meta = { label: `${bitmap.width} × ${bitmap.height}`, width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return meta;
}

// O PNG é um formato sem perdas: o canvas ignora o valor de qualidade e o
// ficheiro resultante fica quase sempre maior do que o original.
export function isLossless(format) {
  return format === 'image/png';
}

function encode(canvas, format, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('O browser não conseguiu codificar a imagem.'))),
      format,
      quality / 100
    );
  });
}

// Garante um ficheiro final mais leve do que o original, sem nunca alterar a
// resolução da imagem (mantém sempre as dimensões da fonte). Mesmo com a
// qualidade no máximo (100) ou com um formato sem perdas como o PNG, tenta
// primeiro o pedido, e só desce a qualidade ou muda de formato (para JPG, que
// comprime muito melhor do que PNG/WebP a qualidades altas) se for preciso.
export async function compressImage(file, quality, format) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();

  const originalSize = file.size;
  let best = null;

  const consider = (candidate) => {
    if (!best || candidate.size < best.size) best = candidate;
  };

  // 1) Tenta a qualidade pedida, no formato pedido.
  consider(await encode(canvas, format, quality));

  // 2) Se ainda não ficou mais leve, desce a qualidade em passos, no mesmo
  //    formato (para PNG isto não ajuda, o toBlob ignora o parâmetro).
  if (best.size >= originalSize && format !== 'image/png') {
    for (const level of [85, 70, 55, 40, 25, 10]) {
      if (level >= quality) continue;
      consider(await encode(canvas, format, level));
      if (best.size < originalSize) break;
    }
  }

  // 3) Ainda maior (ou era PNG)? Converte para JPG, que costuma comprimir
  //    muito melhor do que PNG/WebP a qualidades altas — sem tocar na
  //    resolução da imagem.
  if (best.size >= originalSize && format !== 'image/jpeg') {
    for (const level of [95, 90, 80, 65, 50, 35, 20]) {
      consider(await encode(canvas, 'image/jpeg', level));
      if (best.size < originalSize) break;
    }
  }

  return best;
}
