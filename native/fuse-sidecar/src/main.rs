use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, Generation, INodeNo,
    LockOwner, MountOption, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory,
    ReplyEntry, Request,
};

const TTL: Duration = Duration::from_secs(1);
const HEALTH_CONTENT: &[u8] =
    b"Drive for Linux FUSE 3 sidecar is alive; cloud operations are handled by drive-core.\n";

struct SidecarFs {
    uid: u32,
    gid: u32,
}

impl SidecarFs {
    fn attr(&self, inode: u64) -> Option<FileAttr> {
        let now = SystemTime::now();
        match inode {
            1 => Some(FileAttr {
                ino: INodeNo::ROOT,
                size: 0,
                blocks: 0,
                atime: now,
                mtime: now,
                ctime: now,
                crtime: now,
                kind: FileType::Directory,
                perm: 0o700,
                nlink: 2,
                uid: self.uid,
                gid: self.gid,
                rdev: 0,
                flags: 0,
                blksize: 4096,
            }),
            2 => Some(FileAttr {
                ino: INodeNo(2),
                size: HEALTH_CONTENT.len() as u64,
                blocks: 1,
                atime: now,
                mtime: now,
                ctime: now,
                crtime: now,
                kind: FileType::RegularFile,
                perm: 0o400,
                nlink: 1,
                uid: self.uid,
                gid: self.gid,
                rdev: 0,
                flags: 0,
                blksize: 4096,
            }),
            _ => None,
        }
    }
}

impl Filesystem for SidecarFs {
    fn lookup(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        if u64::from(parent) == 1 && name == OsStr::new(".drive-sidecar-health") {
            reply.entry(&TTL, &self.attr(2).expect("health inode"), Generation(0));
        } else {
            reply.error(Errno::ENOENT);
        }
    }

    fn getattr(
        &self,
        _request: &Request,
        inode: INodeNo,
        _handle: Option<FileHandle>,
        reply: ReplyAttr,
    ) {
        match self.attr(u64::from(inode)) {
            Some(attribute) => reply.attr(&TTL, &attribute),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn readdir(
        &self,
        _request: &Request,
        inode: INodeNo,
        _handle: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        if u64::from(inode) != 1 {
            reply.error(Errno::ENOTDIR);
            return;
        }
        let entries = [
            (INodeNo::ROOT, FileType::Directory, "."),
            (INodeNo::ROOT, FileType::Directory, ".."),
            (INodeNo(2), FileType::RegularFile, ".drive-sidecar-health"),
        ];
        for (index, entry) in entries.iter().enumerate().skip(offset as usize) {
            if reply.add(entry.0, (index + 1) as u64, entry.1, entry.2) {
                break;
            }
        }
        reply.ok();
    }

    fn read(
        &self,
        _request: &Request,
        inode: INodeNo,
        _handle: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        if u64::from(inode) != 2 {
            reply.error(Errno::ENOENT);
            return;
        }
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start >= HEALTH_CONTENT.len() {
            reply.data(&[]);
            return;
        }
        let end = start.saturating_add(size as usize).min(HEALTH_CONTENT.len());
        reply.data(&HEALTH_CONTENT[start..end]);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (mountpoint, socket) = parse_args()?;
    fs::create_dir_all(&mountpoint)?;
    start_control_socket(socket)?;

    let mut config = Config::default();
    config.n_threads = Some(4);
    config.clone_fd = true;
    config.mount_options.extend([
        MountOption::FSName("drive-for-linux".to_string()),
        MountOption::Subtype("drive-fuse3".to_string()),
        MountOption::DefaultPermissions,
        MountOption::NoDev,
        MountOption::NoSuid,
        MountOption::NoExec,
        MountOption::RW,
        MountOption::CUSTOM("max_background=32".to_string()),
        MountOption::CUSTOM("congestion_threshold=24".to_string()),
    ]);
    let filesystem = SidecarFs {
        uid: unsafe { libc::geteuid() },
        gid: unsafe { libc::getegid() },
    };
    fuser::mount(filesystem, mountpoint, &config)?;
    Ok(())
}

fn parse_args() -> Result<(PathBuf, PathBuf), String> {
    let mut arguments = std::env::args_os().skip(1);
    let mut mountpoint = None;
    let mut socket = None;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--mountpoint") => mountpoint = arguments.next().map(PathBuf::from),
            Some("--control-socket") => socket = arguments.next().map(PathBuf::from),
            Some(other) => return Err(format!("unknown argument: {other}")),
            None => return Err("arguments must be valid UTF-8".to_string()),
        }
    }
    Ok((
        mountpoint.ok_or("missing --mountpoint")?,
        socket.ok_or("missing --control-socket")?,
    ))
}

fn start_control_socket(socket: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = socket.parent() {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    if socket.exists() {
        fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    thread::Builder::new()
        .name("drive-fuse-control".to_string())
        .spawn(move || serve_health(listener, &socket))?;
    Ok(())
}

fn serve_health(listener: UnixListener, socket: &Path) {
    for connection in listener.incoming() {
        let Ok(mut stream) = connection else { continue };
        let mut request = [0_u8; 64];
        let count = stream.read(&mut request).unwrap_or(0);
        let command = std::str::from_utf8(&request[..count]).unwrap_or("").trim();
        let response = if command == "health" {
            b"{\"ok\":true,\"backend\":\"fuse3\",\"protocol\":1}\n".as_slice()
        } else {
            b"{\"ok\":false,\"error\":\"unsupported command\"}\n".as_slice()
        };
        let _ = stream.write_all(response);
    }
    let _ = fs::remove_file(socket);
}
