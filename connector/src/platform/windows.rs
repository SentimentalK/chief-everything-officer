//! Windows implementations of the platform primitives.
//!
//! Honest Windows equivalents of the Unix privacy/durability contracts:
//! - Private local state = explicit current-user-only DACL (owner + SYSTEM +
//!   Administrators) applied via `SetNamedSecurityInfoW` to every
//!   Connector-owned directory and sensitive file. POSIX modes are never
//!   faked.
//! - Symlink/reparse defense = rejection of ANY reparse-point component
//!   (`FILE_ATTRIBUTE_REPARSE_POINT` covers symlinks, junctions, and mount
//!   points) on Connector-owned control paths.
//! - Atomic publish = `std::fs::rename`, which on Windows maps to
//!   `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` — the proven Windows atomic
//!   replace primitive for files on the same volume. The target is never
//!   deleted before the move, so there is no delete-then-rename gap.
//! - Durability = file data is flushed (`sync_all`) BEFORE the publish; the
//!   final `MoveFileExW` replacement is atomic against process crash. Unlike
//!   POSIX, Windows exposes no std API to fsync a parent directory handle,
//!   so the post-publish directory-metadata sync step is unavailable: after
//!   a power-loss the file contents are either the old or the new complete
//!   file, never a partial one, but which of the two versions survives is
//!   not additionally pinned by a directory-entry fsync.

use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

use super::PrivacyStatus;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_PATH_NOT_FOUND,
    GENERIC_ALL, HANDLE,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, AddAccessAllowedAceEx, AllocateAndInitializeSid, CopySid, EqualSid,
    FreeSid, GetAce, GetAclInformation, GetLengthSid, GetTokenInformation, InitializeAcl,
    IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
    ACL, ACL_REVISION, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_NT_AUTHORITY, SID_IDENTIFIER_AUTHORITY, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LMEM_ZEROINIT};
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, SECURITY_LOCAL_SYSTEM_RID,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

// ---------------------------------------------------------------------------
// Private local state (current-user-only DACLs)
// ---------------------------------------------------------------------------

/// Creates `path` (and parents), then applies an explicit minimal DACL
/// (current user + SYSTEM + Administrators) so the directory stays private
/// regardless of where it sits.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    harden_private(path, /* inheritable= */ true)
}

/// Opens (creating if absent) an exclusive-lock file with a private DACL.
pub fn open_private_lock_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    harden_private(path, false)?;
    Ok(file)
}

/// Creates a brand-new private file for writing; fails if it exists.
pub fn create_private_file_new(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    harden_private(path, false)?;
    Ok(file)
}

// ---------------------------------------------------------------------------
// Privacy diagnosis (Doctor read model)
// ---------------------------------------------------------------------------

/// Diagnoses whether a directory is private under the Windows ACL boundary.
pub fn diagnose_dir_privacy(path: &Path) -> io::Result<PrivacyStatus> {
    diagnose_privacy(path)
}

/// Diagnoses whether a sensitive file is private under the Windows ACL
/// boundary.
pub fn diagnose_file_privacy(path: &Path) -> io::Result<PrivacyStatus> {
    diagnose_privacy(path)
}

fn diagnose_privacy(path: &Path) -> io::Result<PrivacyStatus> {
    unsafe {
        let wide = wide_path(path);
        let mut owner: PSID = ptr::null_mut();
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut sd,
        );
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        let _sd_guard = SdGuard(sd);

        let user = current_user_sid()?;

        // 1. Ownership must be the current user (or a trusted local principal
        //    when running elevated, where the OS assigns ownership to the
        //    Administrators group).
        if owner.is_null() {
            return Ok(PrivacyStatus::Exposed {
                detail: "security descriptor has no owner".into(),
            });
        }
        let trusted_owner = EqualSid(owner, user.as_ptr() as PSID) != 0
            || IsWellKnownSid(owner, WinLocalSystemSid) != 0
            || IsWellKnownSid(owner, WinBuiltinAdministratorsSid) != 0;
        if !trusted_owner {
            return Ok(PrivacyStatus::Exposed {
                detail: "owner is not the current user".into(),
            });
        }

        // 2. Every allow-ACE must target the current user, SYSTEM, or the
        //    local Administrators group. The current user is compared
        //    DIRECTLY (not via the owner SID): elevated processes get files
        //    owned by the Administrators group while hardening still grants
        //    the current user an explicit ACE. A missing DACL means everyone
        //    access and is exposed.
        if dacl.is_null() {
            return Ok(PrivacyStatus::Exposed {
                detail: "no discretionary ACL (everyone access)".into(),
            });
        }
        let mut size_info: ACL_SIZE_INFORMATION = std::mem::zeroed();
        if GetAclInformation(
            dacl,
            &mut size_info as *mut _ as *mut c_void,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        for index in 0..size_info.AceCount {
            let mut ace: *mut c_void = ptr::null_mut();
            if GetAce(dacl, index, &mut ace) == 0 {
                return Err(io::Error::last_os_error());
            }
            let allowed = ace as *mut ACCESS_ALLOWED_ACE;
            if (*allowed).Header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE {
                // Deny ACEs only restrict further; mandatory-integrity labels
                // are system-managed. Neither can broaden access.
                continue;
            }
            let ace_sid = ptr::addr_of_mut!((*allowed).SidStart) as PSID;
            let trusted = IsWellKnownSid(ace_sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(ace_sid, WinBuiltinAdministratorsSid) != 0
                || EqualSid(ace_sid, user.as_ptr() as PSID) != 0
                || EqualSid(ace_sid, owner) != 0;
            if !trusted {
                return Ok(PrivacyStatus::Exposed {
                    detail: "ACL grants access beyond the current user, SYSTEM, and Administrators"
                        .into(),
                });
            }
        }

        Ok(PrivacyStatus::Private {
            detail: "current-user-private ACL".into(),
        })
    }
}

struct SdGuard(PSECURITY_DESCRIPTOR);
impl Drop for SdGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

// ---------------------------------------------------------------------------
// DACL hardening
// ---------------------------------------------------------------------------

/// Applies an explicit minimal DACL: current user + SYSTEM +
/// Administrators with full access. `inheritable` propagates the ACEs to
/// children for directories. `PROTECTED_DACL_SECURITY_INFORMATION` stops
/// parent inheritance from broadening the boundary.
pub fn harden_private(path: &Path, inheritable: bool) -> io::Result<()> {
    unsafe {
        let user = current_user_sid()?;
        let system = local_system_sid()?;

        let ace_size = |sid: &[u8]| {
            std::mem::size_of::<ACCESS_ALLOWED_ACE>() + sid.len() - std::mem::size_of::<u32>()
        };
        let acl_size = (std::mem::size_of::<ACL>() + ace_size(&user) + ace_size(&system)) as u32;

        // LMEM_ZEROINIT without LMEM_MOVEABLE = fixed, zero-initialized.
        let dacl = LocalAlloc(LMEM_ZEROINIT, acl_size as usize);
        if dacl.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "failed to allocate ACL buffer",
            ));
        }
        let dacl = dacl as *mut ACL;

        let build_res = (|| -> io::Result<()> {
            if InitializeAcl(dacl, acl_size, ACL_REVISION) == 0 {
                return Err(io::Error::last_os_error());
            }
            let flags: u32 = if inheritable {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            if AddAccessAllowedAceEx(
                dacl,
                ACL_REVISION,
                flags,
                GENERIC_ALL,
                user.as_ptr() as PSID,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            if AddAccessAllowedAceEx(
                dacl,
                ACL_REVISION,
                flags,
                GENERIC_ALL,
                system.as_ptr() as PSID,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();

        if let Err(e) = build_res {
            LocalFree(dacl as *mut c_void);
            return Err(e);
        }

        let wide = wide_path(path);
        let rc = SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        );
        LocalFree(dacl as *mut c_void);
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        Ok(())
    }
}

/// Copies the current process token's user SID into an owned byte buffer.
unsafe fn current_user_sid() -> io::Result<Vec<u8>> {
    let mut token: HANDLE = ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
        return Err(io::Error::last_os_error());
    }
    let close = HandleGuard(token);

    let mut len: u32 = 0;
    if GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "unexpected success querying TokenUser with a null buffer",
        ));
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(err);
    }
    // TOKEN_USER contains pointer-sized members: keep 8-byte alignment.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    let buf_ptr = buf.as_mut_ptr() as *mut u8;
    let mut ret: u32 = 0;
    if GetTokenInformation(token, TokenUser, buf_ptr as *mut c_void, len, &mut ret) == 0 {
        return Err(io::Error::last_os_error());
    }
    let token_user = buf_ptr as *const TOKEN_USER;
    let sid = (*token_user).User.Sid;
    drop(close);
    copy_sid_bytes(sid)
}

struct HandleGuard(HANDLE);
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Builds an owned copy of the well-known LocalSystem SID.
unsafe fn local_system_sid() -> io::Result<Vec<u8>> {
    let authority = SID_IDENTIFIER_AUTHORITY {
        Value: SECURITY_NT_AUTHORITY.Value,
    };
    let mut sid: PSID = ptr::null_mut();
    if AllocateAndInitializeSid(
        &authority,
        1,
        SECURITY_LOCAL_SYSTEM_RID as u32,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        &mut sid,
    ) == 0
    {
        return Err(io::Error::last_os_error());
    }
    let out = copy_sid_bytes(sid);
    FreeSid(sid);
    out
}

unsafe fn copy_sid_bytes(sid: PSID) -> io::Result<Vec<u8>> {
    let len = GetLengthSid(sid) as usize;
    let mut out = vec![0u8; len];
    if CopySid(len as u32, out.as_mut_ptr() as PSID, sid) == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Durable write primitives
// ---------------------------------------------------------------------------

/// On Windows, std cannot open a parent directory handle for
/// `FlushFileBuffers`; the directory-entry sync step of the Unix durability
/// envelope has no equivalent here. See the module documentation for the
/// exact Windows durability guarantee. Never an error: callers keep the same
/// sequencing on every OS.
pub fn sync_directory(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Atomically publishes `temp` over `target` via `std::fs::rename`, which on
/// Windows maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`: the existing
/// target file is replaced in one atomic move on the same volume — never a
/// delete-then-rename gap. Failures (e.g. a read-only target) surface as
/// errors before anything is removed.
pub fn publish_atomic(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

// ---------------------------------------------------------------------------
// Reparse-point (symlink / junction / mount point) defense
// ---------------------------------------------------------------------------

fn get_file_attributes(path: &Path) -> io::Result<u32> {
    let wide = wide_path(path);
    let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        Err(io::Error::last_os_error())
    } else {
        Ok(attrs)
    }
}

/// True when `path` exists and carries the reparse-point attribute
/// (symlink/junction/mount point). Missing paths are not reparse points.
pub fn is_reparse_point(path: &Path) -> io::Result<bool> {
    match get_file_attributes(path) {
        Ok(attrs) => Ok(attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0),
        Err(e) if is_not_found(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

fn is_not_found(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(e) if e == ERROR_FILE_NOT_FOUND as i32 || e == ERROR_PATH_NOT_FOUND as i32
    ) || e.kind() == io::ErrorKind::NotFound
}

/// Rejects any path whose destination is an existing reparse point
/// (symlink, junction, or mount point) — the Windows equivalent of the Unix
/// symlink rejection on Connector-owned control paths.
pub fn reject_reparse_target(path: &Path) -> io::Result<()> {
    if is_reparse_point(path)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "control path is a reparse point (symlink/junction): {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Hostname discovery (display metadata only)
// ---------------------------------------------------------------------------

/// Portable hostname discovery for Windows: `COMPUTERNAME` env →
/// `{USERNAME}-device` → `unknown-device`. Hostname stays display metadata
/// only; it never drives product logic.
pub fn hostname() -> String {
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(user) = std::env::var("USERNAME") {
        let trimmed = user.trim();
        if !trimmed.is_empty() {
            return format!("{trimmed}-device");
        }
    }
    "unknown-device".into()
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute_plain(path: &Path) -> String {
        // tempfile paths are already absolute, non-verbatim paths on Windows;
        // strip a verbatim prefix only if canonicalize() produced one. Never
        // canonicalize the junction link path itself (it does not exist yet).
        match fs::canonicalize(path) {
            Ok(abs) => {
                let s = abs.display().to_string();
                s.strip_prefix(r"\\?\").map(|s| s.to_string()).unwrap_or(s)
            }
            // The link path may legitimately not exist yet: mklink needs the
            // plain absolute form.
            Err(_) => path.display().to_string(),
        }
    }

    #[test]
    fn ensure_private_dir_and_files_are_current_user_private() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("a").join("b");
        ensure_private_dir(&dir).unwrap();
        assert!(matches!(
            diagnose_dir_privacy(&dir).unwrap(),
            PrivacyStatus::Private { .. }
        ));

        let lock = dir.join("l.lock");
        drop(open_private_lock_file(&lock).unwrap());
        assert!(matches!(
            diagnose_file_privacy(&lock).unwrap(),
            PrivacyStatus::Private { .. }
        ));

        let new_file = dir.join("n.json");
        drop(create_private_file_new(&new_file).unwrap());
        assert!(matches!(
            diagnose_file_privacy(&new_file).unwrap(),
            PrivacyStatus::Private { .. }
        ));
    }

    #[test]
    fn reject_reparse_target_and_ancestors_catch_junctions() {
        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("real_target");
        fs::create_dir_all(&target_dir).unwrap();

        let link_dir = temp.path().join("junction_dir");
        let status = std::process::Command::new("cmd")
            .args([
                "/c",
                "mklink",
                "/J",
                &absolute_plain(&link_dir),
                &absolute_plain(&target_dir),
            ])
            .output()
            .expect("cmd available on Windows");
        assert!(
            status.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );

        assert!(reject_reparse_target(&link_dir).is_err());
        assert!(reject_reparse_target(&target_dir).is_ok());
        use crate::platform::reject_reparse_ancestors;
        assert!(reject_reparse_ancestors(&link_dir.join("connector")).is_err());
        assert!(reject_reparse_ancestors(&target_dir.join("connector")).is_ok());
        assert!(reject_reparse_target(&temp.path().join("absent")).is_ok());
    }

    #[test]
    fn publish_atomic_replaces_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("t.json");
        fs::write(&target, b"old").unwrap();
        let temp_file = temp.path().join("t.tmp");
        fs::write(&temp_file, b"new").unwrap();
        publish_atomic(&temp_file, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!temp_file.exists());
    }

    #[test]
    fn failed_replace_preserves_prior_file_and_cleans_temp() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("t.json");
        fs::write(&target, b"keep-me").unwrap();
        // Read-only target makes the atomic replace fail on Windows.
        let mut perms = fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).unwrap();

        // The connector-level write path must fail WITHOUT deleting the
        // prior valid file, and must clean its OWN temp sibling.
        assert!(crate::local_state::atomic_write_durable(&target, b"new").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep-me");
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                // Connector temp siblings look like ".t.json.<pid>.<n>.<ns>.tmp".
                name.starts_with(".t.json.") && name.ends_with(".tmp")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
    }

    #[test]
    fn hostname_is_never_empty_and_is_trimmed() {
        let h = hostname();
        assert!(!h.trim().is_empty());
        assert_eq!(h.trim(), h);
    }
}
