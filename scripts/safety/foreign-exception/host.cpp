#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

extern "C" void rustra_safety_callback_probe(
    void (*callback)(void *, const char *, const char *), void *data);

struct State { int calls = 0; int caught = 0; bool abort_on_error = false; };

// A real C++ exception is handled before returning to Rust. C-unwind alone does
// not make a foreign exception entering Rust's catch_unwind safe or predictable.
extern "C" void contained_callback(void *data, const char *name, const char *payload) noexcept {
    auto &state = *static_cast<State *>(data);
    ++state.calls;
    try {
        if (std::strcmp(name, "probe") != 0 || std::strcmp(payload, "1") == 0)
            throw std::runtime_error("injected C++ exception");
    } catch (...) {
        ++state.caught;
        std::fputs("rustra safety: caught C++ exception in host callback\n", stderr);
        if (state.abort_on_error) {
            std::fputs("rustra safety: host explicitly aborting\n", stderr);
            std::fflush(stderr);
            std::abort();
        }
    }
}

int main(int argc, char **argv) {
    State state;
    state.abort_on_error = argc == 2 && std::strcmp(argv[1], "abort") == 0;
    rustra_safety_callback_probe(contained_callback, &state);
    if (state.calls != 2 || state.caught != 1) return 2;
    std::puts("C++ exception contained; second Rust event delivered; unregister returned");
    return 0;
}
