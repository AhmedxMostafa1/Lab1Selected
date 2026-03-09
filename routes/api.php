<?php
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::get('/normal', function () {
    return response()->json(['status' => 'ok']);
});

Route::get('/random', function () {
    $roll = random_int(1, 100);

    if ($roll <= 70) {
        return response()->json(['status' => 'ok']);
    }

    if ($roll <= 90) {
        usleep(random_int(100000, 500000));

        return response()->json(['status' => 'slow success']);
    }

    return response()->json(['status' => 'forced error'], 500);
});

Route::get('/error', function () {
    return response()->json(['status' => 'forced error'], 500);
});

Route::get('/db', function (Request $request) {
    if ($request->query('fail') == '1') {
        // Force a QueryException
        return DB::select('SELECT * FROM non_existent_table');
    }
    // Normal DB query success
    return DB::select('SELECT 1');
});

Route::post('/validate', function (Request $request) {
    $request->validate([
        'email' => 'required|email',
        'age'   => 'required|integer|between:18,60',
    ]);
    return response()->json(['status' => 'success']);
});

Route::get('/slow', function (Request $request) {
    if ($request->query('hard') == '1') {
        sleep(rand(5, 7)); // Sleeps 5-7 seconds
    } else {
        usleep(rand(100000, 500000)); // Normal slow (100-500ms)
    }
    return response()->json(['status' => 'slow success']);
});
