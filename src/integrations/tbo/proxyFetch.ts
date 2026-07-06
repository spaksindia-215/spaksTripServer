// Direct egress for TBO.
//
// The server runs on Hostinger (Cloud Startup) with a fixed public IP, which is
// whitelisted with TBO — so every TBO REST call goes out directly from this
// host. No reverse-proxy hop is needed (the earlier Hostinger PHP tunnel and its
// TBO_PROXY_URL/TBO_PROXY_SECRET vars have been removed).
//
// Kept as a thin wrapper so all TBO call sites share one egress chokepoint; if a
// header/timeout/logging concern ever needs to apply to every TBO request, add
// it here rather than at each call site.
export async function tboFetch(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, options);
}
