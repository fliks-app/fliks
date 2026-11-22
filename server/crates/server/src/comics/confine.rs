//! What the comic archive child may do once it runs (`docs/spec/comics.md`, rule 22): Landlock removes
//! the filesystem, a seccomp filter removes sockets and the ways to reach the server process.
use std::{ffi::CStr, mem::size_of};

const FS_V1: u64 = 0x1fff;
const READ: u64 = 0b1100;
const READABLE: [&CStr; 4] = [
    c"/usr/lib/locale",
    c"/usr/lib/gconv",
    c"/usr/lib/x86_64-linux-gnu/gconv",
    c"/usr/lib/aarch64-linux-gnu/gconv",
];
const RULE_PATH_BENEATH: libc::c_long = 1;

fn abi() -> libc::c_long {
    // SAFETY: the version query takes no pointers.
    unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, 0, 0, 1u32) }
}

/// The parent warns once: the child has no log subscriber.
pub fn probe() {
    if abi() < 1 {
        tracing::warn!(
            "comic archive child: this kernel has no Landlock, its files are not isolated"
        );
    }
}

/// Reads below the locale and charset-conversion data only; the archive is already open on stdin.
fn landlock() {
    #[repr(C, packed)]
    struct PathBeneath {
        allowed: u64,
        parent_fd: i32,
    }
    let abi = abi();
    if abi < 1 {
        return;
    }
    // The kernel rejects a right it does not know: REFER from ABI 2, TRUNCATE from 3, IOCTL_DEV from 5.
    let handled = FS_V1
        | if abi >= 2 { 1 << 13 } else { 0 }
        | if abi >= 3 { 1 << 14 } else { 0 }
        | if abi >= 5 { 1 << 15 } else { 0 };
    // SAFETY: plain syscalls on descriptors and structs owned here.
    unsafe {
        let ruleset = libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &handled as *const u64,
            size_of::<u64>(),
            0u32,
        ) as i32;
        if ruleset < 0 {
            return;
        }
        for path in READABLE {
            let dir = libc::open(
                path.as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
            );
            if dir >= 0 {
                let rule = PathBeneath {
                    allowed: READ,
                    parent_fd: dir,
                };
                libc::syscall(
                    libc::SYS_landlock_add_rule,
                    ruleset,
                    RULE_PATH_BENEATH,
                    &rule as *const PathBeneath,
                    0u32,
                );
                libc::close(dir);
            }
        }
        libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32);
        libc::close(ruleset);
    }
}

#[cfg(target_arch = "x86_64")]
const ARCH: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const ARCH: u32 = 0xc000_00b7;

const LD_ABS: u16 = 0x20;
const JEQ: u16 = 0x15;
#[cfg(target_arch = "x86_64")]
const JGE: u16 = 0x35;
const RET: u16 = 0x06;
const ALLOW: u32 = 0x7fff_0000;
const KILL: u32 = 0x8000_0000;
const DENY: u32 = 0x0005_0000 | libc::EPERM as u32;
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;

fn ins(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

/// No socket, no signal to another process, no ptrace or cross-process memory access: the child
/// keeps the server's uid, so only these separate it from the parent. A thread may signal itself.
fn seccomp() -> bool {
    let denied = [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_pidfd_open,
        libc::SYS_pidfd_getfd,
        libc::SYS_pidfd_send_signal,
        libc::SYS_kill,
        libc::SYS_tkill,
    ];
    let mut f = vec![
        ins(LD_ABS, 0, 0, OFF_ARCH),
        ins(JEQ, 1, 0, ARCH),
        ins(RET, 0, 0, KILL),
        ins(LD_ABS, 0, 0, OFF_NR),
    ];
    // The x32 ABI numbers its calls apart from the list below.
    #[cfg(target_arch = "x86_64")]
    f.extend([ins(JGE, 0, 1, 0x4000_0000), ins(RET, 0, 0, DENY)]);
    for nr in denied {
        f.push(ins(JEQ, 0, 1, nr as u32));
        f.push(ins(RET, 0, 0, DENY));
    }
    // SAFETY: getpid has no preconditions.
    let own = unsafe { libc::getpid() } as u32;
    f.extend([
        ins(JEQ, 0, 3, libc::SYS_tgkill as u32),
        ins(LD_ABS, 0, 0, OFF_ARG0),
        ins(JEQ, 1, 0, own),
        ins(RET, 0, 0, DENY),
        ins(RET, 0, 0, ALLOW),
    ]);
    let prog = libc::sock_fprog {
        len: f.len() as u16,
        filter: f.as_mut_ptr(),
    };
    // SAFETY: `prog` points at `f`, which outlives the call; the kernel copies the filter.
    unsafe { libc::prctl(libc::PR_SET_SECCOMP, 2, &prog as *const libc::sock_fprog) == 0 }
}

/// Called first in the child. False when the filter cannot be installed: the child does not run unconfined.
pub fn enter() -> bool {
    // SAFETY: a plain prctl; Landlock refuses an unprivileged process without it.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return false;
    }
    landlock();
    seccomp()
}
