<?php

namespace Tests\Unit;

use App\Services\PrometheusClient;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class PrometheusClientTest extends TestCase
{
    public function test_it_fetches_required_endpoint_metrics(): void
    {
        Http::fake([
            'http://localhost:9090/api/v1/query*' => function ($request) {
                $query = $request['query'];

                return Http::response([
                    'status' => 'success',
                    'data' => [
                        'result' => match (true) {
                            str_contains($query, 'rate(http_requests_total') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '1.5'],
                                ],
                            ],
                            str_contains($query, 'rate(http_errors_total') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '0.15'],
                                ],
                            ],
                            str_contains($query, 'rate(http_request_duration_seconds_sum') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '0.08'],
                                ],
                            ],
                            str_contains($query, 'histogram_quantile(0.50') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '0.06'],
                                ],
                            ],
                            str_contains($query, 'histogram_quantile(0.95') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '0.22'],
                                ],
                            ],
                            str_contains($query, 'histogram_quantile(0.99') => [
                                [
                                    'metric' => ['path' => '/api/normal'],
                                    'value' => [1710000000, '0.30'],
                                ],
                            ],
                            str_contains($query, 'increase(http_errors_total') => [
                                [
                                    'metric' => ['path' => '/api/normal', 'error_category' => 'DATABASE_ERROR'],
                                    'value' => [1710000000, '2'],
                                ],
                            ],
                            default => [],
                        ],
                    ],
                ]);
            },
        ]);

        $client = new PrometheusClient(
            app(HttpFactory::class),
            'http://localhost:9090',
            5
        );

        $metrics = $client->fetchEndpointMetrics(['/api/normal']);

        $this->assertSame(1.5, $metrics['/api/normal']['request_rate']);
        $this->assertEqualsWithDelta(0.1, $metrics['/api/normal']['error_rate'], 0.0001);
        $this->assertSame(0.08, $metrics['/api/normal']['average_latency']);
        $this->assertSame(0.22, $metrics['/api/normal']['latency_percentiles']['p95']);
        $this->assertSame(2.0, $metrics['/api/normal']['error_category_counters']['DATABASE_ERROR']);
    }
}
