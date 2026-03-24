<?php

namespace App\Services;

use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Client\RequestException;
use RuntimeException;

class PrometheusClient
{
    public function __construct(
        private readonly HttpFactory $http,
        private readonly string $baseUrl,
        private readonly int $timeoutSeconds = 5,
    ) {
    }

    /**
     * @param  string[]  $endpoints
     * @return array<string, mixed>
     *
     * @throws RequestException|RuntimeException
     */
    public function fetchEndpointMetrics(array $endpoints): array
    {
        $regex = $this->buildEndpointRegex($endpoints);

        $requestRates = $this->queryScalarByPath(
            sprintf(
                'sum by (path) (rate(http_requests_total{path=~"%s"}[2m]))',
                $regex
            )
        );

        $errorRatesPerSecond = $this->queryScalarByPath(
            sprintf(
                'sum by (path) (rate(http_errors_total{path=~"%s"}[2m]))',
                $regex
            )
        );

        $averageLatency = $this->queryScalarByPath(
            sprintf(
                'sum by (path) (rate(http_request_duration_seconds_sum{path=~"%s"}[5m])) / sum by (path) (rate(http_request_duration_seconds_count{path=~"%s"}[5m]))',
                $regex,
                $regex
            )
        );

        $p50Latency = $this->queryScalarByPath(
            sprintf(
                'histogram_quantile(0.50, sum by (le, path) (rate(http_request_duration_seconds_bucket{path=~"%s"}[5m])))',
                $regex
            )
        );

        $p95Latency = $this->queryScalarByPath(
            sprintf(
                'histogram_quantile(0.95, sum by (le, path) (rate(http_request_duration_seconds_bucket{path=~"%s"}[5m])))',
                $regex
            )
        );

        $p99Latency = $this->queryScalarByPath(
            sprintf(
                'histogram_quantile(0.99, sum by (le, path) (rate(http_request_duration_seconds_bucket{path=~"%s"}[5m])))',
                $regex
            )
        );

        $errorCategoryCounters = $this->queryErrorCategoryCounters(
            sprintf(
                'sum by (path, error_category) (increase(http_errors_total{path=~"%s"}[5m]))',
                $regex
            )
        );

        $metrics = [];

        foreach ($endpoints as $endpoint) {
            $requestRate = $requestRates[$endpoint] ?? 0.0;
            $errorsPerSecond = $errorRatesPerSecond[$endpoint] ?? 0.0;

            $metrics[$endpoint] = [
                'request_rate' => $requestRate,
                'error_rate' => $requestRate > 0 ? $errorsPerSecond / $requestRate : 0.0,
                'errors_per_second' => $errorsPerSecond,
                'average_latency' => $averageLatency[$endpoint] ?? 0.0,
                'latency_percentiles' => [
                    'p50' => $p50Latency[$endpoint] ?? 0.0,
                    'p95' => $p95Latency[$endpoint] ?? 0.0,
                    'p99' => $p99Latency[$endpoint] ?? 0.0,
                ],
                'error_category_counters' => $errorCategoryCounters[$endpoint] ?? [],
            ];
        }

        return $metrics;
    }

    /**
     * @return array<string, float>
     */
    private function queryScalarByPath(string $query): array
    {
        $results = $this->performQuery($query);
        $values = [];

        foreach ($results as $result) {
            $path = $result['metric']['path'] ?? null;
            $value = $result['value'][1] ?? null;

            if (! is_string($path) || ! is_numeric($value)) {
                continue;
            }

            $values[$path] = (float) $value;
        }

        return $values;
    }

    /**
     * @return array<string, array<string, float>>
     */
    private function queryErrorCategoryCounters(string $query): array
    {
        $results = $this->performQuery($query);
        $values = [];

        foreach ($results as $result) {
            $path = $result['metric']['path'] ?? null;
            $errorCategory = $result['metric']['error_category'] ?? null;
            $value = $result['value'][1] ?? null;

            if (! is_string($path) || ! is_string($errorCategory) || ! is_numeric($value)) {
                continue;
            }

            $values[$path][$errorCategory] = (float) $value;
        }

        return $values;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function performQuery(string $query): array
    {
        $response = $this->http
            ->baseUrl($this->baseUrl)
            ->timeout($this->timeoutSeconds)
            ->acceptJson()
            ->get('/api/v1/query', ['query' => $query])
            ->throw();

        $payload = $response->json();

        if (($payload['status'] ?? null) !== 'success') {
            throw new RuntimeException('Prometheus query failed to return a success status.');
        }

        $results = $payload['data']['result'] ?? null;

        return is_array($results) ? $results : [];
    }

    /**
     * @param  string[]  $endpoints
     */
    private function buildEndpointRegex(array $endpoints): string
    {
        return implode('|', array_map(
            static fn (string $endpoint): string => str_replace(
                ['\\', '"'],
                ['\\\\', '\"'],
                preg_quote($endpoint, '"')
            ),
            $endpoints
        ));
    }
}
