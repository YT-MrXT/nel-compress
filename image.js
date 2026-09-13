export const imageMode = {
  accept: 'image/jpeg,image/png,image/webp',
  extension: 'webp',
  pageTitle: 'Comprimir imagem',
  heading: 'Escolhe a tua imagem',
  formats: 'JPG, PNG e WebP são suportados.',
  selectLabel: 'Selecionar imagem',
  note: '',
};

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export function validateImage(file) {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error(`${file.type || 'Este formato'} não é uma imagem suportada. Usa JPG, PNG ou WebP.`);
  }
}

export async function describeImage(file) {
  const bitmap = await createImageBitmap(file);
  const description = `${bitmap.width} × ${bitmap.height}`;
  bitmap.close();
  return description;
}

export async function compressImage(file, quality) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('O browser não conseguiu codificar a imagem.'))),
      'image/webp',
      quality / 100
    );
  });
}
