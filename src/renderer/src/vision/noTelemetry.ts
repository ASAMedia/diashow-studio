// MediaPipe reports usage statistics to Google. Answering that request locally keeps it from going
// out (the worker has no page CSP to block it) and from logging errors. Imported first by worker.ts.
const TELEMETRY = 'odml.pa.googleapis.com'
const realFetch = self.fetch.bind(self)
self.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return url.includes(TELEMETRY) ? Promise.resolve(new Response(null, { status: 204 })) : realFetch(input, init)
}

export {}
