// Host smoke test for the rustra wasm spike engine — runs the REAL wasm3
// interpreter against the REAL .wasm artifact with a full postcard round-trip
// through linear memory staging. Desktop mirror of what the RN native modules
// do on iOS/Android.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include "wasm3.h"

static uint8_t* g_mem;
static size_t g_mem_size;
static IM3Module g_module;

static void sync_mem(void) {
    g_mem = m3_GetMemory(g_module, &g_mem_size, 0);
    if (!g_mem) { fprintf(stderr, "m3_GetMemory failed\n"); exit(1); }
}

static uint32_t call_fn(IM3Module mod, const char* name,
                        uint32_t argc, const uint32_t* args, uint32_t* out_ret) {
    IM3Function fn = NULL;
    M3Result r = m3_FindFunctionIn(&fn, mod, name);
    if (r) { fprintf(stderr, "find %s: %s\n", name, r); exit(1); }
    if (argc == 0) r = m3_CallV(fn);
    else if (argc == 1) r = m3_CallV(fn, args[0]);
    else if (argc == 2) r = m3_CallV(fn, args[0], args[1]);
    else if (argc == 3) r = m3_CallV(fn, args[0], args[1], args[2]);
    else { fprintf(stderr, "argc>3 unsupported\n"); exit(1); }
    if (r) { fprintf(stderr, "call %s: %s\n", name, r); exit(1); }
    uint32_t ret = 0;
    if (out_ret) {
        r = m3_GetResultsV(fn, out_ret);
        if (r) { fprintf(stderr, "ret %s: %s\n", name, r); exit(1); }
    }
    (void)ret;
    return out_ret ? *out_ret : 0;
}

static void hexdump(const char* tag, const uint8_t* p, uint32_t n) {
    printf("%s (%u bytes): ", tag, n);
    for (uint32_t i = 0; i < n; i++) printf("%02x", p[i]);
    printf("\n");
}

// postcard envelope (String, String): varint len + bytes, twice
static uint32_t make_envelope(uint8_t* out, const char* cmd, const char* args) {
    uint32_t n = 0;
    size_t cl = strlen(cmd), al = strlen(args);
    out[n++] = (uint8_t)cl;
    memcpy(out + n, cmd, cl); n += (uint32_t)cl;
    out[n++] = (uint8_t)al;
    memcpy(out + n, args, al); n += (uint32_t)al;
    return n;
}

// Full round trip: request bytes -> wasm -> response bytes. Returns resp len.
static uint32_t wasm_invoke(IM3Runtime rt, IM3Module mod,
                            const uint8_t* req, uint32_t req_len,
                            uint8_t* out_resp, uint32_t out_cap) {
    uint32_t a = req_len;                 uint32_t req_off = 0;
    call_fn(mod, "spike_alloc", 1, &a, &req_off);
    a = 4;                                uint32_t len_off = 0;
    call_fn(mod, "spike_alloc", 1, &a, &len_off);
    sync_mem();
    memset(g_mem + len_off, 0, 4);
    memcpy(g_mem + req_off, req, req_len);
    uint32_t invoke_args[3] = { req_off, req_len, len_off };
    uint32_t resp_off = 0;
    call_fn(mod, "spike_invoke", 3, invoke_args, &resp_off);
    sync_mem();
    uint32_t resp_len;
    memcpy(&resp_len, g_mem + len_off, 4);
    if (resp_len > out_cap) { fprintf(stderr, "resp too big: %u\n", resp_len); exit(1); }
    memcpy(out_resp, g_mem + resp_off, resp_len);
    // free
    uint32_t f0[2] = { resp_off, resp_len }; call_fn(mod, "spike_free", 2, f0, NULL);
    uint32_t f1[2] = { req_off, req_len };   call_fn(mod, "spike_unstage", 2, f1, NULL);
    uint32_t f2[2] = { len_off, 4 };         call_fn(mod, "spike_unstage", 2, f2, NULL);
    return resp_len;
}

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s engine.wasm\n", argv[0]); return 2; }
    FILE* f = fopen(argv[1], "rb");
    if (!f) { perror("fopen"); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t* buf = malloc(sz);
    if (fread(buf, 1, sz, f) != (size_t)sz) { perror("fread"); return 1; }
    fclose(f);
    printf("[host] wasm loaded: %ld bytes\n", sz);

    struct timespec t0, t1, t2, t3;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    IM3Environment env = m3_NewEnvironment();
    IM3Runtime runtime = m3_NewRuntime(env, 256u * 1024 * 1024, NULL);
    IM3Module module = NULL;
    M3Result r = m3_ParseModule(env, &module, buf, sz);
    if (r) { fprintf(stderr, "[host] parse: %s\n", r); return 1; }
    r = m3_LoadModule(runtime, module);
    if (r) { fprintf(stderr, "[host] load: %s\n", r); return 1; }
    g_module = module;
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    printf("[host] parse+load: %.1f ms\n", ms);

    uint32_t ver = 0;
    call_fn(module, "spike_engine_version", 0, NULL, &ver);
    printf("[host] spike_engine_version = %u\n", ver);

    // contract hash: returns ptr; len via out_len protocol (ptr arg pattern)
    // spike_contract_hash(out_len_ptr) -> ptr
    uint32_t a4 = 4;
    uint32_t len_off = 0;
    call_fn(module, "spike_alloc", 1, &a4, &len_off);
    sync_mem();
    memset(g_mem + len_off, 0, 4);
    uint32_t hargs[1] = { len_off };
    uint32_t hash_off = 0;
    call_fn(module, "spike_contract_hash", 1, hargs, &hash_off);
    sync_mem();
    uint32_t hash_len; memcpy(&hash_len, g_mem + len_off, 4);
    printf("[host] contract_hash = ");
    for (uint32_t i = 0; i < hash_len; i++) putchar(g_mem[hash_off + i]);
    printf("\n");

    // invoke double(n=21)
    uint8_t req[256], resp[4096];
    uint32_t req_len = make_envelope(req, "double", "{\"n\":21}");
    clock_gettime(CLOCK_MONOTONIC, &t2);
    uint32_t resp_len = wasm_invoke(runtime, module, req, req_len, resp, sizeof(resp));
    clock_gettime(CLOCK_MONOTONIC, &t3);
    double call_ms = (t3.tv_sec - t2.tv_sec) * 1e3 + (t3.tv_nsec - t2.tv_nsec) / 1e6;
    hexdump("[host] double(21) resp", resp, resp_len);
    printf("[host] wasm3 invoke round-trip: %.3f ms\n", call_ms);

    // 100-call benchmark
    clock_gettime(CLOCK_MONOTONIC, &t2);
    for (int i = 0; i < 100; i++) {
        wasm_invoke(runtime, module, req, req_len, resp, sizeof(resp));
    }
    clock_gettime(CLOCK_MONOTONIC, &t3);
    printf("[host] 100 invokes avg: %.3f ms\n",
           ((t3.tv_sec - t2.tv_sec) * 1e3 + (t3.tv_nsec - t2.tv_nsec) / 1e6) / 100.0);

    printf("[host] SMOKE OK\n");
    return 0;
}
