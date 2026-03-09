<?php

use App\Support\PrometheusMetrics;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::get('/metrics', function () {
    return response(
        PrometheusMetrics::render(),
        200,
        ['Content-Type' => 'text/plain; version=0.0.4; charset=utf-8']
    );
});
