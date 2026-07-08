import http from "node:http";

// Loopback HTTP sink. It plays two roles for the detonated package:
//   1. A fake npm registry / callback host (env points the package at it).
//   2. An HTTP proxy target (http_proxy env), so proxy-aware clients route here.
// Every received request is recorded; bodies are scanned for canary tokens so a
// package that exfiltrates a stolen credential to "the internet" is caught even
// when it uses a plain HTTP client. The sink answers 200 to everything so the
// payload proceeds as if exfiltration succeeded (more behavior to observe).
export async function startSink({ canaryTokens = [] } = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const leakedToken = canaryTokens.find((token) => token && body.includes(token)) || null;
      requests.push({
        method: req.method,
        // For proxied requests req.url is an absolute URI; for direct hits it is a path.
        url: req.url,
        host: req.headers.host || null,
        bodyLength: body.length,
        leakedToken,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
