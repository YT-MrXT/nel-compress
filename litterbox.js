// O litterbox não envia cabeçalhos CORS, por isso o browser recusa falar com ele
// diretamente. Esta função reencaminha o pedido a partir do servidor, onde o CORS
// não se aplica. É uma Edge Function e não uma função normal porque estas passam
// o corpo em streaming, sem o limite de 6 MB das funções normais.

const UPSTREAM = 'https://litterbox.catbox.moe/resources/internals/api.php';

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('[proxy] vivo. Este endereço só aceita POST.', { status: 200 });
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

  const body = await upstream.text();

  // O prefixo distingue uma resposta vinda daqui de uma página de erro do Netlify.
  return new Response(upstream.ok ? body : `[proxy] o litterbox respondeu ${upstream.status}: ${body}`, {
    status: upstream.status,
    headers: { 'content-type': 'text/plain' },
  });
};

export const config = { path: '/api/litterbox' };
