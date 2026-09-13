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

export async function compressImage(file, quality, format) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('O browser não conseguiu codificar a imagem.'))),
      format,
      quality / 100
    );
  });
}
