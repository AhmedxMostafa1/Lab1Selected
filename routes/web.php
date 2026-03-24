<?php

use App\Support\PrometheusMetrics;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\View\Middleware\ShareErrorsFromSession;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::withoutMiddleware([
    EncryptCookies::class,
    AddQueuedCookiesToResponse::class,
    VerifyCsrfToken::class,
    StartSession::class,
    ShareErrorsFromSession::class,
])->get('/metrics', function () {
    return response(
        PrometheusMetrics::render(),
        200,
        ['Content-Type' => 'text/plain; version=0.0.4; charset=utf-8']
    );
});
