<?php
header('Content-Type: application/json');

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helper.php';

require_auth();

$query = isset($_GET['q']) ? trim($_GET['q']) : '';
$limit = isset($_GET['limit']) ? min((int)$_GET['limit'], 50) : 20;

if (strlen($query) < 2) {
    http_response_code(400);
    echo json_encode(['error' => 'Query parameter "q" is required (min 2 chars)']);
    exit;
}

try {
    $raw = ebay_request([
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
        'paginationInput.entriesPerPage' => $limit,
        'outputSelector(0)'           => 'PictureURLLarge',
        'outputSelector(1)'           => 'GalleryInfo',
    ]);

    $searchResult = $raw['findCompletedItemsResponse'][0]['searchResult'][0] ?? [];
    $items        = $searchResult['item'] ?? [];
    $total        = (int)($searchResult['@count'] ?? 0);

    $results = [];
    foreach ($items as $item) {
        $results[] = [
            'itemId'    => $item['itemId'][0]    ?? '',
            'title'     => $item['title'][0]     ?? '',
            'price'     => $item['sellingStatus'][0]['currentPrice'][0]['__value__'] ?? null,
            'currency'  => $item['sellingStatus'][0]['currentPrice'][0]['@currencyId'] ?? 'USD',
            'soldDate'  => $item['listingInfo'][0]['endTime'][0] ?? null,
            'imageUrl'  => $item['pictureURLLarge'][0] ?? ($item['galleryURL'][0] ?? null),
            'itemUrl'   => $item['viewItemURL'][0] ?? '',
            'condition' => $item['condition'][0]['conditionDisplayName'][0] ?? 'Unknown',
        ];
    }

    echo json_encode(['results' => $results, 'total' => $total, 'mock' => false]);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to fetch from eBay', 'detail' => $e->getMessage()]);
}
