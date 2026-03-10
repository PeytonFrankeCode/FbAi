<?php
header('Content-Type: application/json');

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helper.php';

require_auth();

$query = isset($_GET['q']) ? trim($_GET['q']) : '';

if (strlen($query) < 2) {
    http_response_code(400);
    echo json_encode(['error' => 'Query parameter "q" is required (min 2 chars)']);
    exit;
}

// First two words of query used to build per-variant search queries
$player = implode(' ', array_slice(preg_split('/\s+/', $query), 0, 2));

try {
    $raw   = ebay_request([
        'OPERATION-NAME'              => 'findCompletedItems',
        'SERVICE-VERSION'             => '1.0.0',
        'SECURITY-APPNAME'            => EBAY_APP_ID,
        'RESPONSE-DATA-FORMAT'        => 'JSON',
        'REST-PAYLOAD'                => '',
        'keywords'                    => $query,
        'categoryId'                  => '261328',
        'itemFilter(0).name'          => 'SoldItemsOnly',
        'itemFilter(0).value'         => 'true',
        'sortOrder'                   => 'EndTimeSoonest',
        'paginationInput.entriesPerPage' => 50,
        'outputSelector(0)'           => 'PictureURLLarge',
        'outputSelector(1)'           => 'GalleryInfo',
    ]);

    $items      = $raw['findCompletedItemsResponse'][0]['searchResult'][0]['item'] ?? [];
    $variantMap = [];

    foreach ($items as $item) {
        $title    = $item['title'][0] ?? '';
        $year     = extract_year($title);
        $set      = extract_set($title);
        $parallel = extract_parallel($title);

        if (!$year && !$set) continue;

        $parts = array_filter([$year, $set ? 'Panini ' . $set : '', $parallel]);
        $displayName = implode(' ', $parts);
        if (!$displayName) continue;

        $key   = strtolower($displayName);
        $price = (float)($item['sellingStatus'][0]['currentPrice'][0]['__value__'] ?? 0);
        $img   = $item['pictureURLLarge'][0] ?? ($item['galleryURL'][0] ?? null);

        if (!isset($variantMap[$key])) {
            $variantMap[$key] = ['displayName' => $displayName, 'prices' => [], 'imageUrl' => null];
        }
        if ($price > 0) $variantMap[$key]['prices'][] = $price;
        if (!$variantMap[$key]['imageUrl'] && $img) $variantMap[$key]['imageUrl'] = $img;
    }

    $variants = [];
    foreach ($variantMap as $key => $v) {
        $prices = $v['prices'];
        $count  = count($prices);
        $avg    = $count ? array_sum($prices) / $count : 0;

        $variants[] = [
            'id'          => preg_replace('/[^a-z0-9]+/', '-', $key),
            'displayName' => $v['displayName'],
            'searchQuery' => $player . ' ' . $v['displayName'],
            'salesCount'  => $count,
            'avgPrice'    => $avg,
            'priceRange'  => $count ? ['min' => min($prices), 'max' => max($prices)] : null,
            'imageUrl'    => $v['imageUrl'],
        ];
    }

    // Sort by sales count descending, take top 12
    usort($variants, fn($a, $b) => $b['salesCount'] - $a['salesCount']);
    $variants = array_slice($variants, 0, 12);

    echo json_encode(['variants' => array_values($variants), 'mock' => false]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to fetch variants from eBay', 'detail' => $e->getMessage()]);
}
