#include <napi.h>
#include <uv.h>
#include <string>
#include <vector>
#include <iostream>

#ifdef __linux__
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#endif

// Event model matching the eBPF kernel program
struct SyscallEventPayload {
    uint32_t pid;
    uint32_t event_type;
    uint32_t fd;
    uint64_t bytes_written;
    uint64_t timestamp_ns;
    std::string comm;
    std::string filename;
};

// Global thread-safe function for libuv event-loop dispatch
static Napi::ThreadSafeFunction tsfn;
static bool is_interceptor_running = false;

// Callback dispatcher invoked on the JavaScript main event loop
void CallJs(Napi::Env env, Napi::Function jsCallback, SyscallEventPayload* data) {
    if (env != nullptr && jsCallback != nullptr && data != nullptr) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid", Napi::Number::New(env, data->pid));
        obj.Set("eventType", Napi::String::New(env, data->event_type == 1 ? "OPENAT" : "WRITE"));
        obj.Set("fd", Napi::Number::New(env, data->fd));
        obj.Set("bytesWritten", Napi::Number::New(env, static_cast<double>(data->bytes_written)));
        obj.Set("timestampNs", Napi::Number::New(env, static_cast<double>(data->timestamp_ns)));
        obj.Set("comm", Napi::String::New(env, data->comm));
        obj.Set("filename", Napi::String::New(env, data->filename));

        jsCallback.Call({obj});
        delete data;
    }
}

// Node-API method: checkKernelSupport
Napi::Value CheckKernelSupport(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
#ifdef __linux__
    return Napi::Boolean::New(env, true);
#else
    // macOS Darwin / Windows do not support Linux eBPF tracepoints directly
    return Napi::Boolean::New(env, false);
#endif
}

// Node-API method: initInterceptor(callback)
Napi::Value InitInterceptor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Callback function required").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Function cb = info[0].As<Napi::Function>();

    tsfn = Napi::ThreadSafeFunction::New(
        env,
        cb,
        "eBPF Event Callback",
        0,
        1
    );

    is_interceptor_running = true;
    return Napi::Boolean::New(env, true);
}

// Node-API method: addTrackedPid(pid)
Napi::Value AddTrackedPid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "PID integer required").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
    // In real Linux eBPF, update target_pids BPF hash map here
    return Napi::Boolean::New(env, true);
}

// Node-API method: stopInterceptor()
Napi::Value StopInterceptor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    is_interceptor_running = false;
    if (tsfn) {
        tsfn.Release();
    }
    return Napi::Boolean::New(env, true);
}

// Addon Initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("checkKernelSupport", Napi::Function::New(env, CheckKernelSupport));
    exports.Set("initInterceptor", Napi::Function::New(env, InitInterceptor));
    exports.Set("addTrackedPid", Napi::Function::New(env, AddTrackedPid));
    exports.Set("stopInterceptor", Napi::Function::New(env, StopInterceptor));
    return exports;
}

NODE_API_MODULE(rewind_bpf, Init)
