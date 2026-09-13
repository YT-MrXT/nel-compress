// O litterbox não envia cabeçalhos CORS, por isso o browser recusa falar com ele
// diretamente. Esta função reencaminha o pedido a partir do servidor, onde o CORS
// não se aplica. É uma Edge Function e não uma função normal porque estas passam
// o corpo em streaming, sem o limite de 6 MB das funções normais.

const UPSTREAM = 'https://litterbox.catbox.moe/resources/internals/api.php';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Este endereço só aceita POST.', { status: 405 });
  }

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type'),
      'user-agent': 'NelCompress',
    },
    body: request.body,
    duplex: 'half',
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'text/plain' },
  });
};

export const config = { path: '/api/litterbox' };
