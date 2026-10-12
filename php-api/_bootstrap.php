<?php
/**
 * Shared helpers for all JSON endpoints.
 *
 * TWO DATA SOURCES SUPPORTED:
 *   1. MOCK  - local data/providers.php fixtures (default, no vendor needed)
 *   2. PAID  - the paid commercial API, once you have credentials
 *
 * Switch by setting the env var MATKA_PROVIDER=paid
 * and filling in api/config.php
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');

// The market clock + scheduling helpers live with the fixture data.
// Required here because normalizeMarket() below schedules every market
// against the current time.
require_once __DIR__ . '/data/mock.php';

/** Emit JSON and exit. */
function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Fail with a consistent error envelope. */
function fail(string $message, int $status = 400): never
{
    respond(['ok' => false, 'error' => $message], $status);
}

function providerName(): string
{
    $env = getenv('MATKA_PROVIDER');
    return ($env !== false && $env !== '') ? $env : 'mock';
}

/**
 * Derive the single "ank" digit from a result value.
 *
 * The winning ank is the last digit of the JODI, and a result is printed as
 * "open-jodi-close", so for three parts the jodi is the MIDDLE one:
 *   "257-48-369" -> 8   ("369" would be the close panna, not the result)
 *   "257-48"     -> 8
 *   "369"        -> 9
 * Returns null when no numeric result is present (pending market).
 */
function deriveAnk(mixed $value): ?int
{
    if ($value === null || $value === '') {
        return null;
    }

    // Split on the '-' separators, keep the numeric chunks.
    $parts = preg_split('/[^0-9]+/', (string) $value, -1, PREG_SPLIT_NO_EMPTY);
    if (!$parts) {
        return null;
    }

    // three parts -> the jodi is in the middle; otherwise the last part.
    $part = count($parts) >= 3 ? $parts[1] : end($parts);

    if ($part === '' || !is_numeric($part)) {
        return null;
    }

    $num = (int) $part;
    if ($num < 0) {
        return null;
    }

    return $num % 10;
}

/**
 * Normalise any provider payload into OUR fixed UI schema.
 * This is the single place where vendor field names get mapped,
 * so swapping providers never touches the React components.
 *
 * UI contract:
 *   market, open, close, jodi, openTime, closeTime, ank, status, slug
 */
function normalizeMarket(array $row): array
{
    $open   = $row['open']   ?? null;
    $close  = $row['close']  ?? null;
    $jodi   = $row['jodi']   ?? null;

    // Build the display string.
    //   three parts -> "257-48-369"
    //   two parts   -> "357-5"   (markets with no separate jodi)
    $hasAll = $open !== null && $close !== null && $jodi !== null && $jodi !== '';
    $hasPair = $open !== null && $close !== null && !$hasAll;

    if ($hasAll) {
        $result = $open . '-' . $close . '-' . $jodi;
    } elseif ($hasPair) {
        $result = $open . '-' . $close;
    } elseif ($jodi !== null && $jodi !== '') {
        $result = (string) $jodi;
    } else {
        $result = null;
    }

    // Clock-driven, not result-driven: a market inside its draw window is
    // "live" even before anything has been published for it. Mirrors
    // publicStatus() in server/services/marketClock.js.
    $openMin  = mockToMinutes($row['openTime'] ?? null);
    $closeMin = mockToMinutes($row['closeTime'] ?? null);
    $win      = mockWindowStatus($openMin, $closeMin, mockNowMinutes());

    if ($win === 'live') {
        $status = 'live';
    } elseif ($win === 'unknown') {
        $status = $result === null ? 'pending' : 'closed';
    } else {
        $status = $result !== null ? 'closed' : ($win === 'upcoming' ? 'upcoming' : 'pending');
    }

    return [
        'market'     => $row['market'] ?? '',
        'open'       => $open,
        'close'      => $close,
        'jodi'       => $jodi,
        'result'     => $result,
        'openTime'   => $row['openTime'] ?? '',
        'closeTime'  => $row['closeTime'] ?? '',
        'ank'        => $row['ank'] ?? deriveAnk($result),
        'status'     => $status,
        'slug'       => $row['slug'] ?? '',
        'jodiUrl'    => '/jodi-chart-record/' . ($row['slug'] ?? '') . '.php',
        'panelUrl'   => '/panel-chart-record/' . ($row['slug'] ?? '') . '.php',
    ];
}

// Content sections (Final Ank, starline tables, weekly charts, free game
// zone, day tables, pass list, link zones) live in a shared JSON file so
// the PHP API and the Node fallback serve byte-identical payloads.
function sections(): array
{
    static $cache = null;

    if ($cache === null) {
        $path = __DIR__ . '/data/sections.json';
        $raw  = @file_get_contents($path);
        if ($raw === false) {
            http_response_code(500);
            echo json_encode(['ok' => false, 'error' => 'Missing data/sections.json']);
            exit;
        }
        $cache = json_decode($raw, true);
        if (!is_array($cache)) {
            http_response_code(500);
            echo json_encode(['ok' => false, 'error' => 'sections.json is not valid JSON']);
            exit;
        }
    }

    return $cache;
}

/** Fetch the raw dataset from the active provider and normalize it. */
function getAllMarkets(): array
{
    $provider = providerName();

    if ($provider === 'paid') {
        $raw = paidProviderFetchAll();
    } else {
        require_once __DIR__ . '/data/mock.php';
        $raw = mockMarkets();
    }

    $rows = array_map('normalizeMarket', $raw);

    // Public list is ordered by OPEN time (earliest first) - the same
    // chronology the homepage grid renders. Unparseable times sink to the
    // end; ties break alphabetically so the order never flickers.
    usort($rows, static function (array $a, array $b): int {
        $ta = mockToMinutes($a['openTime'] ?? null);
        $tb = mockToMinutes($b['openTime'] ?? null);
        if ($ta === null && $tb === null) {
            return strcmp((string) ($a['market'] ?? ''), (string) ($b['market'] ?? ''));
        }
        if ($ta === null) {
            return 1;
        }
        if ($tb === null) {
            return -1;
        }
        if ($ta !== $tb) {
            return $ta <=> $tb;
        }
        return strcmp((string) ($a['market'] ?? ''), (string) ($b['market'] ?? ''));
    });

    return $rows;
}

function getMarketBySlug(string $slug): ?array
{
    foreach (getAllMarkets() as $m) {
        if ($m['slug'] === $slug) {
            return $m;
        }
    }
    return null;
}
