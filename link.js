// Pedido para a nossa própria origem: o reencaminhamento para o litterbox
// acontece do lado do servidor, em netlify/edge-functions/litterbox.js.
const API = '/api/litterbox';
const EXPIRY = '72h';
export const EXPIRY_DAYS = 3;

export const linkMode = {
  accept: 'image/*,video/*',
  pageTitle: 'Criar link',
  heading: 'Escolhe o ficheiro',
  formats: 'Qualquer imagem ou vídeo, até 1 GB. O link expira ao fim de 3 dias.',
  selectLabel: 'Selecionar ficheiro',
  note: 'O ficheiro sai do teu dispositivo e fica acessível a quem tiver o endereço.',
  lede: 'Escolhe um ficheiro e recebe um link para partilhar.',
  setupHeading: 'Confirma e envia',
  setupSub: 'O ficheiro é enviado para o litterbox, que devolve um endereço público.',
  steps: ['Ficheiro', 'Enviar', 'Link'],
  action: 'Gerar link',
};

export function validateForLink(file) {
  if (!/^(image|video)\//.test(file.type)) {
    throw new Error('Só imagens e vídeos podem ser transformados em link.');
  }
}

export async function describeForLink(file) {
  return { label: file.type };
}

export function expiryDate() {
  const date = new Date(Date.now() + EXPIRY_DAYS * 86400000);
  return date.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// XMLHttpRequest em vez de fetch porque só ele reporta o progresso do upload.
export function uploadFile(file, onProgress) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', EXPIRY);
  form.append('fileToUpload', file, file.name);

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', API);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };

    request.onload = () => {
      const body = request.responseText.trim();
      if (request.status === 200 && body.startsWith('https://')) {
        resolve(body);
      } else {
        reject(new Error(`O litterbox recusou o ficheiro (${request.status}). ${body}`));
      }
    };

    request.onerror = () => reject(new Error('O envio não chegou ao servidor. Verifica a ligação.'));

    request.send(form);
  });
}
