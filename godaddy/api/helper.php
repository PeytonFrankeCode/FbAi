<?php
// ---- Shared helpers (not directly web-accessible) ----

// Extract Bearer token from Authorization header
function get_bearer_token() {
    $auth = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION'] : '';
    // Fallback for some Apache configs that strip the header
    if (!$auth && function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        $auth = isset($headers['Authorization']) ? $headers['Authorization']
              : (isset($headers['authorization']) ? $headers['authorization'] : '');
    }
    if (preg_match('/^Bearer\s+(.+)$/i', $auth, $m)) {
        return trim($m[1]);
    }
    return null;
}

// Validate session token; exits with 401 if invalid
function require_auth() {
    $token = get_bearer_token();
    if (!$token) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }
    // Restore the session that was created during login
    session_id($token);
    session_start();
    if (empty($_SESSION['authed'])) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }
}

// Make a GET request to the eBay Finding API and return decoded JSON
function ebay_request($params) {
    $url = 'https://svcs.ebay.com/services/search/FindingService/v1?' . http_build_query($params);
    $ch  = curl_init();
    curl_setopt($ch, CURLOPT_URL,            $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT,        10);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    $body      = curl_exec($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err       = curl_error($ch);
    curl_close($ch);

    if ($err)           throw new Exception('cURL error: ' . $err);
    if ($http_code !== 200) throw new Exception('eBay returned HTTP ' . $http_code);

    return json_decode($body, true);
}

// ---- Title parsing ----
$KNOWN_SETS = [
    'Prizm', 'Select', 'Mosaic', 'Optic', 'Donruss', 'Bowman', 'Topps', 'Chronicles',
    'Contenders', 'Score', 'Immaculate', 'Spectra', 'Fleer', 'Hoops', 'Revolution',
    'Absolute', 'Certified', 'Playoff', 'National Treasures',
];
$KNOWN_PARALLELS = [
    'Silver', 'Gold', 'Blue', 'Green', 'Red', 'Purple', 'Orange', 'Pink',
    'Holo', 'Shimmer', 'Hyper', 'Concourse', 'Rainbow', 'Scope', 'Disco',
    'Neon', 'Wave', 'Camo', 'Tie-Dye', 'Black', 'White', 'Aqua', 'Teal',
    'Emerald', 'Ruby', 'Sapphire', 'Copper',
];

function extract_year($title) {
    if (preg_match('/\b(201[5-9]|202[0-9])\b/', $title, $m)) return $m[1];
    return '';
}

function extract_set($title) {
    global $KNOWN_SETS;
    $lower = strtolower($title);
    foreach ($KNOWN_SETS as $s) {
        if (strpos($lower, strtolower($s)) !== false) return $s;
    }
    return '';
}

function extract_parallel($title) {
    global $KNOWN_PARALLELS;
    $lower = strtolower($title);
    foreach ($KNOWN_PARALLELS as $p) {
        if (strpos($lower, strtolower($p)) !== false) return $p;
    }
    return '';
}
