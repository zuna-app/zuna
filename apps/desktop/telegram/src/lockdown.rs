//! What the engine does to itself on Linux before it runs a line of TDLib's or reads a byte from
//! Telegram: the half of its box the app can't make for it (docs/TELEGRAM_PLAN.md, A process of
//! its own, in a box). The app has already given it namespaces of its own and Landlock's hold on
//! its files (`platform/sandbox.rs`), which last through exec. This adds, on the one thread there
//! is so far, which every thread after takes:
//!
//! - **No core dump, and nobody to attach.** Not dumpable, so the session's keys never reach a
//!   crash report and no other program of the person's may read its memory.
//! - **One port.** Landlock for TCP, from kernel 6.7: no port bound but the door's, which it has
//!   already, and none connected to but the door's. Where the app could give it no network of its
//!   own, as where a distribution keeps namespaces from programs, this is what holds it in. Every
//!   layer of Landlock refuses moving a file from one folder to another unless it allows it, so
//!   this one allows it in the engine's folder, where TDLib moves what it downloads and sends
//!   from its `temp` into place, and the app's layer still holds it to that folder.
//! - **seccomp.** No program started, no process made, no ptrace, no namespaces, no io_uring, no
//!   kernel modules or BPF, no socket but TCP over IPv4 and IPv6, and no signal but to itself.

use std::io::{Error, Result};

#[path = "confine.rs"]
mod confine;

pub fn lock(door_port: u16) -> Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(Error::last_os_error());
    }
    // The app set no new privileges before exec, which lasts; set again in case it's started
    // alone. Landlock and seccomp both need it.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(Error::last_os_error());
    }
    let abi = confine::abi();
    if abi >= 4 {
        let ruleset = confine::Ruleset::new(confine::REFER, confine::network(abi), 0)?;
        // The engine's folder, which the app starts it in.
        ruleset.allow_path(&std::env::current_dir()?, confine::REFER)?;
        ruleset.allow_port(door_port, confine::CONNECT_TCP)?;
        confine::restrict(ruleset.raw())?;
    }
    install(&filter(std::process::id()))
}

/// Instructions of classic BPF, with jumps to labels, made into the filter's offsets by `assemble`.
enum Op {
    Load(u32),
    And(u32),
    /// Compares the accumulator with a number: equal, at least, or any of its bits set.
    Jump(u16, u32, Label, Label),
    Return(u32),
    At(Label),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Label {
    Next,
    Allow,
    Deny,
    NoSystemCall,
    NoFamily,
    Kill,
    Socket,
    Stream,
    Clone,
    Own,
}

// The parts of `struct seccomp_data` the filter reads: the call, the architecture, and the low
// half of the first two arguments, which is all of an int.
const NR: u32 = 0;
const ARCH: u32 = 4;
const ARG0: u32 = 16;
const ARG1: u32 = 24;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00b7;

const ALLOW: u32 = 0x7fff_0000;

/// Calls refused outright: starting a program, reaching into another process, namespaces and
/// mounts, the kernel's own machinery, and io_uring, whose requests seccomp never sees.
fn refused() -> Vec<libc::c_long> {
    let mut calls = vec![
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_process_madvise,
        libc::SYS_pidfd_getfd,
        libc::SYS_pidfd_send_signal,
        libc::SYS_kcmp,
        libc::SYS_tkill,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_mount_setattr,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_acct,
    ];
    #[cfg(target_arch = "x86_64")]
    calls.extend([libc::SYS_fork, libc::SYS_vfork, libc::SYS_uselib]);
    calls
}

/// The filter, for the process whose ID is `me`.
fn filter(me: u32) -> Vec<libc::sock_filter> {
    use Label::*;
    let eq = libc::BPF_JEQ as u16;
    let set = libc::BPF_JSET as u16;
    let mut ops = vec![Op::Load(ARCH), Op::Jump(eq, AUDIT_ARCH, Next, Kill), Op::Load(NR)];
    // x32's calls, which are x86-64's with a bit set, and would get past every number below.
    #[cfg(target_arch = "x86_64")]
    ops.push(Op::Jump(libc::BPF_JGE as u16, 0x4000_0000, Deny, Next));
    for call in refused() {
        ops.push(Op::Jump(eq, call as u32, Deny, Next));
    }
    // Threads are made with clone, which glibc falls back to when clone3, whose flags seccomp
    // can't read, isn't there.
    ops.push(Op::Jump(eq, libc::SYS_clone3 as u32, NoSystemCall, Next));
    ops.push(Op::Jump(eq, libc::SYS_socket as u32, Socket, Next));
    ops.push(Op::Jump(eq, libc::SYS_clone as u32, Clone, Next));
    for call in [libc::SYS_kill, libc::SYS_tgkill, libc::SYS_rt_sigqueueinfo, libc::SYS_rt_tgsigqueueinfo] {
        ops.push(Op::Jump(eq, call as u32, Own, Next));
    }
    ops.push(Op::Return(ALLOW));
    // A socket: TCP over IPv4 or IPv6, and nothing else, so no UDP, no local socket of another
    // program's, no netlink.
    ops.extend([
        Op::At(Socket),
        Op::Load(ARG0),
        Op::Jump(eq, libc::AF_INET as u32, Stream, Next),
        Op::Jump(eq, libc::AF_INET6 as u32, Stream, NoFamily),
        Op::At(Stream),
        Op::Load(ARG1),
        Op::And(0xf),
        Op::Jump(eq, libc::SOCK_STREAM as u32, Allow, Deny),
    ]);
    // clone: a thread, in the namespaces it has, and never a process. 0x80 is CLONE_NEWTIME.
    let namespaces = (libc::CLONE_NEWNS | libc::CLONE_NEWCGROUP | libc::CLONE_NEWUTS | libc::CLONE_NEWIPC | libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_NEWNET) as u32 | 0x80;
    ops.extend([Op::At(Clone), Op::Load(ARG0), Op::Jump(set, namespaces, Deny, Next), Op::Jump(set, libc::CLONE_THREAD as u32, Allow, Deny)]);
    // A signal: to itself, its own threads included, and no other process.
    ops.extend([Op::At(Own), Op::Load(ARG0), Op::Jump(eq, me, Allow, Deny)]);
    ops.extend([
        Op::At(Allow),
        Op::Return(ALLOW),
        Op::At(Deny),
        Op::Return(libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
        Op::At(NoSystemCall),
        Op::Return(libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32),
        Op::At(NoFamily),
        Op::Return(libc::SECCOMP_RET_ERRNO | libc::EAFNOSUPPORT as u32),
        Op::At(Kill),
        Op::Return(libc::SECCOMP_RET_KILL_PROCESS),
    ]);
    assemble(&ops)
}

fn assemble(ops: &[Op]) -> Vec<libc::sock_filter> {
    // Where each label is, counted in instructions.
    let mut at = std::collections::HashMap::new();
    let mut position = 0usize;
    for op in ops {
        match op {
            Op::At(label) => {
                at.insert(*label, position);
            }
            _ => position += 1,
        }
    }
    let mut program = Vec::new();
    for op in ops {
        let here = program.len();
        let offset = |label: Label| -> u8 {
            if label == Label::Next {
                return 0;
            }
            let distance = at[&label] - here - 1;
            u8::try_from(distance).expect("a jump within the filter's reach")
        };
        let instruction = |code: u32, jt: u8, jf: u8, k: u32| libc::sock_filter { code: code as u16, jt, jf, k };
        match op {
            Op::Load(offset) => program.push(instruction(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0, 0, *offset)),
            Op::And(mask) => program.push(instruction(libc::BPF_ALU | libc::BPF_AND | libc::BPF_K, 0, 0, *mask)),
            Op::Jump(kind, value, yes, no) => program.push(instruction(libc::BPF_JMP | *kind as u32 | libc::BPF_K, offset(*yes), offset(*no), *value)),
            Op::Return(value) => program.push(instruction(libc::BPF_RET | libc::BPF_K, 0, 0, *value)),
            Op::At(_) => {}
        }
    }
    program
}

/// Installs the filter on every thread the process has, which is the one.
fn install(program: &[libc::sock_filter]) -> Result<()> {
    let prog = libc::sock_fprog { len: program.len() as u16, filter: program.as_ptr() as *mut libc::sock_filter };
    if unsafe { libc::syscall(libc::SYS_seccomp, libc::SECCOMP_SET_MODE_FILTER, libc::SECCOMP_FILTER_FLAG_TSYNC, &prog as *const libc::sock_fprog) } != 0 {
        return Err(Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every jump lands inside the program, and every path through it ends in a return.
    #[test]
    fn the_filter_is_well_made() {
        let program = filter(1234);
        assert!(program.len() < 200);
        for (index, instruction) in program.iter().enumerate() {
            if instruction.code as u32 & 0x07 == libc::BPF_JMP {
                assert!(index + 1 + (instruction.jt as usize) < program.len());
                assert!(index + 1 + (instruction.jf as usize) < program.len());
            }
        }
        assert_eq!(program.last().unwrap().code as u32, libc::BPF_RET | libc::BPF_K);
    }
}
