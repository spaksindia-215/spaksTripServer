// Static-IP egress for TBO.
//
// TBO whitelists our OUTBOUND IP. On Railway the egress IP is dynamic, so when
// TBO_PROXY_URL is set we tunnel every TBO request through a fixed-IP reverse
// proxy (a PHP script on Hostinger shared hosting — see server/deploy/tbo-proxy.php).
//
// The real TBO target (full https URL, any of the 4 TBO hosts) is sent in the
// X-TBO-Target header; the proxy validates X-Proxy-Key, confirms the target is a
// known TBO host, then forwards the JSON body via cURL from its static IP and
// returns TBO's status + body verbatim.
//
// When TBO_PROXY_URL is unset (local dev / cert), we call TBO directly — no
// behaviour change. Every TBO REST call is a POST, so the proxy hop is POST too.
export async function tboFetch(url: string, options: RequestInit): Promise<Response> {
  const proxyUrl = process.env.TBO_PROXY_URL;
  if (!proxyUrl) return fetch(url, options);

  const headers = new Headers(options.headers);
  headers.set("X-TBO-Target", url);
  const secret = process.env.TBO_PROXY_SECRET;
  if (secret) headers.set("X-Proxy-Key", secret);

  return fetch(proxyUrl, {
    ...options,
    method: "POST",
    headers,
  });
}
