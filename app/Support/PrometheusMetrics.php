<?php

namespace App\Support;

class PrometheusMetrics
{
    private const STORAGE_PATH = 'app/prometheus_metrics.json';
    private const ANOMALY_WINDOW_SECONDS = 300;

    /**
     * Keep buckets tuned to API latencies, from fast in-memory handlers to slow I/O.
     *
     * @var float[]
     */
    private const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

    public static function trackRequest(string $method, string $path, int $statusCode, float $durationSeconds, string $errorCategory): void
    {
        $method = strtoupper($method);
        $path = self::normalizePath($path);
        $status = (string) $statusCode;

        self::withStore(function (array &$store) use ($method, $path, $status, $durationSeconds, $errorCategory): void {
            $requestLabel = self::buildLabelKey([
                'method' => $method,
                'path' => $path,
                'status' => $status,
            ]);

            $store['http_requests_total'][$requestLabel] = (int) ($store['http_requests_total'][$requestLabel] ?? 0) + 1;

            if ($errorCategory !== 'NONE') {
                $errorLabel = self::buildLabelKey([
                    'method' => $method,
                    'path' => $path,
                    'error_category' => $errorCategory,
                ]);

                $store['http_errors_total'][$errorLabel] = (int) ($store['http_errors_total'][$errorLabel] ?? 0) + 1;
            }

            foreach (self::BUCKETS as $bucket) {
                if ($durationSeconds <= $bucket) {
                    $bucketLabel = self::buildLabelKey([
                        'method' => $method,
                        'path' => $path,
                        'le' => self::formatBucket($bucket),
                    ]);

                    $store['http_request_duration_seconds_bucket'][$bucketLabel] = (int) ($store['http_request_duration_seconds_bucket'][$bucketLabel] ?? 0) + 1;
                }
            }

            $infBucketLabel = self::buildLabelKey([
                'method' => $method,
                'path' => $path,
                'le' => '+Inf',
            ]);
            $store['http_request_duration_seconds_bucket'][$infBucketLabel] = (int) ($store['http_request_duration_seconds_bucket'][$infBucketLabel] ?? 0) + 1;

            $summaryLabel = self::buildLabelKey([
                'method' => $method,
                'path' => $path,
            ]);
            $store['http_request_duration_seconds_sum'][$summaryLabel] = (float) ($store['http_request_duration_seconds_sum'][$summaryLabel] ?? 0) + $durationSeconds;
            $store['http_request_duration_seconds_count'][$summaryLabel] = (int) ($store['http_request_duration_seconds_count'][$summaryLabel] ?? 0) + 1;

            if (in_array($errorCategory, ['DATABASE_ERROR', 'SYSTEM_ERROR', 'TIMEOUT_ERROR'], true)) {
                $store['anomaly_window_ends_at'] = max(
                    (int) ($store['anomaly_window_ends_at'] ?? 0),
                    time() + self::ANOMALY_WINDOW_SECONDS
                );
            }
        });
    }

    public static function render(): string
    {
        $store = self::readStore();

        $lines = [
            '# HELP http_requests_total Total number of HTTP requests processed.',
            '# TYPE http_requests_total counter',
        ];
        foreach (self::sortedEntries($store['http_requests_total'] ?? []) as [$labels, $value]) {
            $lines[] = 'http_requests_total{'.$labels.'} '.(int) $value;
        }

        $lines[] = '# HELP http_errors_total Total number of HTTP error-classified requests.';
        $lines[] = '# TYPE http_errors_total counter';
        foreach (self::sortedEntries($store['http_errors_total'] ?? []) as [$labels, $value]) {
            $lines[] = 'http_errors_total{'.$labels.'} '.(int) $value;
        }

        $lines[] = '# HELP http_request_duration_seconds Request duration in seconds.';
        $lines[] = '# TYPE http_request_duration_seconds histogram';
        foreach (self::sortedEntries($store['http_request_duration_seconds_bucket'] ?? []) as [$labels, $value]) {
            $lines[] = 'http_request_duration_seconds_bucket{'.$labels.'} '.(int) $value;
        }
        foreach (self::sortedEntries($store['http_request_duration_seconds_sum'] ?? []) as [$labels, $value]) {
            $lines[] = 'http_request_duration_seconds_sum{'.$labels.'} '.sprintf('%.6F', (float) $value);
        }
        foreach (self::sortedEntries($store['http_request_duration_seconds_count'] ?? []) as [$labels, $value]) {
            $lines[] = 'http_request_duration_seconds_count{'.$labels.'} '.(int) $value;
        }

        $lines[] = '# HELP aiops_anomaly_window Marks anomaly detection window (1 active, 0 inactive).';
        $lines[] = '# TYPE aiops_anomaly_window gauge';
        $lines[] = 'aiops_anomaly_window '.self::anomalyWindowValue($store);

        return implode("\n", $lines)."\n";
    }

    private static function anomalyWindowValue(array $store): int
    {
        $windowEndsAt = (int) ($store['anomaly_window_ends_at'] ?? 0);

        return $windowEndsAt >= time() ? 1 : 0;
    }

    private static function normalizePath(string $path): string
    {
        $path = '/'.ltrim($path, '/');

        return preg_replace(
            [
                '/\/[0-9]+(?=\/|$)/',
                '/\/[0-9a-fA-F]{8,}(?=\/|$)/',
            ],
            '/{id}',
            $path
        ) ?? $path;
    }

    private static function buildLabelKey(array $labels): string
    {
        $parts = [];
        foreach ($labels as $name => $value) {
            $parts[] = $name.'="'.self::escape((string) $value).'"';
        }

        return implode(',', $parts);
    }

    private static function escape(string $value): string
    {
        return str_replace(
            ["\\", "\n", '"'],
            ["\\\\", "\\n", '\\"'],
            $value
        );
    }

    private static function formatBucket(float $value): string
    {
        return rtrim(rtrim(sprintf('%.2F', $value), '0'), '.');
    }

    private static function sortedEntries(array $entries): array
    {
        ksort($entries);

        $result = [];
        foreach ($entries as $labels => $value) {
            $result[] = [$labels, $value];
        }

        return $result;
    }

    private static function storageFilePath(): string
    {
        return storage_path(self::STORAGE_PATH);
    }

    private static function withStore(callable $callback): void
    {
        $path = self::storageFilePath();
        $directory = dirname($path);
        if (! is_dir($directory)) {
            mkdir($directory, 0777, true);
        }

        $handle = fopen($path, 'c+');
        if ($handle === false) {
            return;
        }

        try {
            if (! flock($handle, LOCK_EX)) {
                return;
            }

            $contents = stream_get_contents($handle);
            $store = self::decodeStore($contents !== false ? $contents : '');

            $callback($store);

            rewind($handle);
            ftruncate($handle, 0);
            fwrite($handle, json_encode($store, JSON_PRETTY_PRINT));
            fflush($handle);
            flock($handle, LOCK_UN);
        } finally {
            fclose($handle);
        }
    }

    private static function readStore(): array
    {
        $path = self::storageFilePath();
        if (! is_file($path)) {
            return self::emptyStore();
        }

        $handle = fopen($path, 'r');
        if ($handle === false) {
            return self::emptyStore();
        }

        try {
            if (! flock($handle, LOCK_SH)) {
                return self::emptyStore();
            }

            $contents = stream_get_contents($handle);
            flock($handle, LOCK_UN);

            return self::decodeStore($contents !== false ? $contents : '');
        } finally {
            fclose($handle);
        }
    }

    private static function decodeStore(string $contents): array
    {
        if ($contents === '') {
            return self::emptyStore();
        }

        $decoded = json_decode($contents, true);
        if (! is_array($decoded)) {
            return self::emptyStore();
        }

        return array_merge(self::emptyStore(), $decoded);
    }

    private static function emptyStore(): array
    {
        return [
            'http_requests_total' => [],
            'http_errors_total' => [],
            'http_request_duration_seconds_bucket' => [],
            'http_request_duration_seconds_sum' => [],
            'http_request_duration_seconds_count' => [],
            'anomaly_window_ends_at' => 0,
        ];
    }
}
