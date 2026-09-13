// O litterbox não envia cabeçalhos CORS, por isso o browser não pode falar com
// ele diretamente. Esta função reencaminha o pedido a partir do servidor.
//
// Não basta repassar o corpo tal como chega: o Netlify entrega-o em streaming e
// sem Content-Length, e o parser de multipart do PHP responde 500 nesse caso.
// Por isso o formulário é lido e reconstruído aqui, o que dá ao pedido de saída
// um tamanho conhecido — a mesma forma que um curl produz.

const UPSTREAM = 'https://litterbox.catbox.moe/resources/internals/api.php';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('[proxy] vivo. Este endereço só aceita POST.', { status: 200 });
  }

  const incoming = await request.formData();
  const file = incoming.get('fileToUpload');

  if (!(file instanceof File)) {
    return new Response('[proxy] o pedido não trazia ficheiro.', { status: 400 });
  }

  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', incoming.get('time'));
  form.append('fileToUpload', file, file.name);

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    body: form,
    headers: { 'user-agent': 'curl/8.4.0' },
  });

  const body = await upstream.text();

  // O prefixo distingue uma resposta nossa de uma página de erro do Netlify.
  return new Response(upstream.ok ? body : `[proxy] o litterbox respondeu ${upstream.status}`, {
    status: upstream.status,
    headers: { 'content-type': 'text/plain' },
  });
};

export const config = { path: '/api/litterbox' };
