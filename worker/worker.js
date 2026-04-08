// Cloudflare Worker: proxies recording uploads to GitHub
// The GH_TOKEN secret is stored in Cloudflare, never exposed in client code.

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'PUT') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Expect path like /upload/recordings/sess_xxx_speaker/word_1.webm
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/upload\//, '');
    if (!path) {
      return new Response('Missing file path', { status: 400 });
    }

    // Forward to GitHub Contents API
    const body = await request.json();
    const ghResp = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${env.GH_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'minimal-pairs-recorder',
        },
        body: JSON.stringify({
          message: body.message || `Upload ${path}`,
          content: body.content,
        }),
      }
    );

    const ghBody = await ghResp.text();
    return new Response(ghBody, {
      status: ghResp.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
    });
  },
};
