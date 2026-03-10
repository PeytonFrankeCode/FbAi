<?php
header('Content-Type: application/json');

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

require_once __DIR__ . '/config.php';

$input = json_decode(file_get_contents('php://input'), true);
$code  = isset($input['code']) ? trim($input['code']) : '';

if (!$code || $code !== AUTH_CODE) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid access code']);
    exit;
}

session_start();
$_SESSION['authed'] = true;
echo json_encode(['token' => session_id()]);
