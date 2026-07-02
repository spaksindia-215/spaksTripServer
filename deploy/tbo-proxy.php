<?php
/**
 * TBO static-IP reverse proxy for SpaksTrip.
 *
 * Railway's egress IP is dynamic; TBO whitelists by IP. Upload this file to the
 * Hostinger site (which has a fixed IP) and point the backend at it via
 * TBO_PROXY_URL=https://<your-hostinger-domain>/tbo-proxy.php
 *
 * Flow: validate the shared secret -> confirm the target is a known TBO host
 * (so this is NOT an open proxy) -> forward the JSON body via cURL from the
 * static IP -> return TBO's status code + body verbatim.
 *
 * NOTE: TBO authenticates via TokenId INSIDE the JSON body, not via an HTTP
 * header, so no Authorization header is forwarded here.
 */

// Book/Ticket can take up to 300s. Shared hosting may still cap this lower via
// php.ini max_execution_time; if Book/Ticket times out, raise it in .htaccess:
//   php_value max_execution_time 300
@set_time_limit(300);

header('Content-Type: application/json');

// Set TBO_PROXY_SECRET as a PHP env var in Hostinger (hPanel → PHP Config → env vars),
// or replace the empty string below with your secret directly on the server (do NOT commit a real value here).
$PROXY_SECRET = getenv('TBO_PROXY_SECRET') ?: '';

// 1) Shared-secret auth (constant-time compare)
$provided = isset($_SERVER['HTTP_X_PROXY_KEY']) ? $_SERVER['HTTP_X_PROXY_KEY'] : '';
if (!hash_equals($PROXY_SECRET, $provided)) {
    http_response_code(403);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// 2) Target + SSRF allowlist (only real TBO hosts, https only)
$target = isset($_SERVER['HTTP_X_TBO_TARGET']) ? $_SERVER['HTTP_X_TBO_TARGET'] : '';
$host   = parse_url($target, PHP_URL_HOST);
$scheme = parse_url($target, PHP_URL_SCHEME);
$allowed = [
    'api.travelboutiqueonline.com',      // shared (auth)
    'tboapi.travelboutiqueonline.com',   // air (search/farequote/ssr/farerule)
    'booking.travelboutiqueonline.com',  // book/ticket/getbooking
    'api.tektravels.com',                // hotel
];
if (!$host || $scheme !== 'https' || !in_array($host, $allowed, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid or disallowed target', 'host' => $host]);
    exit;
}

// 3) Forward the body to TBO from this host's static IP
$body = file_get_contents('php://input');
$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $body,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 300,
    CURLOPT_CONNECTTIMEOUT => 30,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Accept: application/json',
    ],
]);
$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err      = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Upstream request failed', 'detail' => $err]);
    exit;
}

http_response_code($status ?: 502);
echo $response;
