// Pedido para a nossa própria origem: o reencaminhamento para o catbox
// acontece do lado do servidor, em netlify/edge-functions/catbox.js.
const API = '/api/catbox';

export const linkMode = {
  accept: 'image/*,video/*',
  pageTitle: 'Criar link',
  heading: 'Escolhe o ficheiro',
  formats: 'Qualquer imagem ou vídeo, até 200 MB. O link não expira.',
  selectLabel: 'Selecionar ficheiro',
  note: 'O ficheiro sai do teu dispositivo e fica acessível a quem tiver o endereço, de forma permanente.',
  lede: 'Escolhe um ficheiro e recebe um link para partilhar.',
  setupHeading: 'Confirma e envia',
  setupSub: 'O ficheiro é enviado para o catbox, que devolve um endereço público permanente.',
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

// XMLHttpRequest em vez de fetch porque só ele reporta o progresso do upload.
export function uploadFile(file, onProgress) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
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
      } else if (body.startsWith('[proxy]')) {
        reject(new Error(body));
      } else if (request.status === 404) {
        reject(new Error('O endereço /api/catbox não existe. A Edge Function não foi publicada.'));
      } else {
        reject(new Error(`Resposta inesperada (${request.status}).`));
      }
    };

    request.onerror = () => reject(new Error('O envio não chegou ao servidor. Verifica a ligação.'));

    request.send(form);
  });
}
