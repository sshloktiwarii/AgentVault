// SPDX-License-Identifier: GPL-2.0
/*
 * Rewind eBPF Kernel Interceptor
 * Intercepts sys_enter_openat and sys_enter_write for agent process trees.
 */

#ifndef __KERNEL__
#define __KERNEL__
#endif

#include <linux/types.h>
#include <linux/bpf.h>

/* BPF Helper Definitions and Section Macros */
#ifndef SEC
#define SEC(NAME) __attribute__((section(NAME), used))
#endif

#ifndef BPF_MAP_TYPE_HASH
#define BPF_MAP_TYPE_HASH 1
#endif

#ifndef BPF_MAP_TYPE_RINGBUF
#define BPF_MAP_TYPE_RINGBUF 27
#endif

/* Maximum Path Length */
#define MAX_PATH_LEN 256
#define COMM_LEN 16

/* Event Data Structure streamed to user-space */
struct syscall_event_t {
    __u32 pid;
    __u32 ppid;
    __u32 fd;
    __u32 event_type; // 1 = OPENAT, 2 = WRITE
    __u64 bytes_written;
    __u64 timestamp_ns;
    char comm[COMM_LEN];
    char filename[MAX_PATH_LEN];
};

/* BPF Map Definition */
struct bpf_map_def {
    unsigned int type;
    unsigned int key_size;
    unsigned int value_size;
    unsigned int max_entries;
    unsigned int map_flags;
};

/* Tracked Agent Process IDs */
struct bpf_map_def SEC("maps") target_pids = {
    .type = BPF_MAP_TYPE_HASH,
    .key_size = sizeof(__u32),
    .value_size = sizeof(__u8),
    .max_entries = 1024,
    .map_flags = 0,
};

/* BPF Ring Buffer for Zero-Copy Streaming */
struct bpf_map_def SEC("maps") events_ringbuf = {
    .type = BPF_MAP_TYPE_RINGBUF,
    .max_entries = 256 * 1024, // 256 KB ring buffer
};

/* Helper function forward declarations */
static void *(*bpf_map_lookup_elem)(void *map, const void *key) = (void *) 1;
static __u64 (*bpf_ktime_get_ns)(void) = (void *) 5;
static __u64 (*bpf_get_current_pid_tgid)(void) = (void *) 14;
static long (*bpf_get_current_comm)(void *buf, __u32 size_of_buf) = (void *) 16;
static long (*bpf_probe_read_user_str)(void *dst, __u32 size, const void *unsafe_ptr) = (void *) 114;
static void *(*bpf_ringbuf_reserve)(void *ringbuf, __u64 size, __u64 flags) = (void *) 131;
static void (*bpf_ringbuf_submit)(void *data, __u64 flags) = (void *) 132;
static void (*bpf_ringbuf_discard)(void *data, __u64 flags) = (void *) 133;

/* Syscall Arguments Structures */
struct sys_enter_openat_args {
    unsigned long long unused;
    long syscall_nr;
    long dfd;
    const char *filename;
    long flags;
    long mode;
};

struct sys_enter_write_args {
    unsigned long long unused;
    long syscall_nr;
    unsigned long fd;
    const char *buf;
    size_t count;
};

/* Tracepoint: sys_enter_openat */
SEC("tracepoint/syscalls/sys_enter_openat")
int trace_sys_enter_openat(struct sys_enter_openat_args *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid >> 32);

    /* Verify if PID is in tracked agent process tree */
    __u8 *is_tracked = bpf_map_lookup_elem(&target_pids, &pid);
    if (!is_tracked) {
        return 0;
    }

    struct syscall_event_t *event = bpf_ringbuf_reserve(&events_ringbuf, sizeof(*event), 0);
    if (!event) {
        return 0;
    }

    event->pid = pid;
    event->event_type = 1; // OPENAT
    event->fd = (__u32)ctx->dfd;
    event->bytes_written = 0;
    event->timestamp_ns = bpf_ktime_get_ns();

    bpf_get_current_comm(&event->comm, sizeof(event->comm));
    bpf_probe_read_user_str(&event->filename, sizeof(event->filename), ctx->filename);

    bpf_ringbuf_submit(event, 0);
    return 0;
}

/* Tracepoint: sys_enter_write */
SEC("tracepoint/syscalls/sys_enter_write")
int trace_sys_enter_write(struct sys_enter_write_args *ctx) {
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = (__u32)(pid_tgid >> 32);

    /* Verify if PID is in tracked agent process tree */
    __u8 *is_tracked = bpf_map_lookup_elem(&target_pids, &pid);
    if (!is_tracked) {
        return 0;
    }

    struct syscall_event_t *event = bpf_ringbuf_reserve(&events_ringbuf, sizeof(*event), 0);
    if (!event) {
        return 0;
    }

    event->pid = pid;
    event->event_type = 2; // WRITE
    event->fd = (__u32)ctx->fd;
    event->bytes_written = (__u64)ctx->count;
    event->timestamp_ns = bpf_ktime_get_ns();
    event->filename[0] = '\0';

    bpf_get_current_comm(&event->comm, sizeof(event->comm));

    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
