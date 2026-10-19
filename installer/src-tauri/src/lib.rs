//! Native side of the Shani Shvilin PC installer.
//!
//! The UI and the installation flow live in the shared TypeScript core. This side only
//! provides what a web page cannot do:
//! - download Google's platform-tools on first run and run the official adb binary,
//! - push a file to the device through adb,
//! - HTTPS GET through the OS certificate store (no CORS, works behind NetFree),
//! - open links in the default browser.

use serde::Serialize;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

#[cfg(windows)]
const PLATFORM_TOOLS_URL: &str = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
#[cfg(target_os = "macos")]
const PLATFORM_TOOLS_URL: &str = "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip";
#[cfg(all(unix, not(target_os = "macos")))]
const PLATFORM_TOOLS_URL: &str = "https://dl.google.com/android/repository/platform-tools-latest-linux.zip";

#[cfg(windows)]
const ADB_NAME: &str = "adb.exe";
#[cfg(not(windows))]
const ADB_NAME: &str = "adb";

/// Files extracted from the platform-tools zip. adb.exe needs the two DLLs on Windows.
#[cfg(windows)]
const TOOL_FILES: &[&str] = &["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"];
#[cfg(not(windows))]
const TOOL_FILES: &[&str] = &["adb"];

/// The only hosts the installer talks to.
const ALLOWED_URL_PREFIXES: &[&str] = &[
    "https://shanishvilin.abaye.co/",
    "https://dl.google.com/android/repository/",
];

const MIN_ZIP_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_TIMEOUT: Duration = Duration::from_secs(900);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("platform-tools"))
        .map_err(|e| e.to_string())
}

/// adb next to the exe wins (lets users drop platform-tools in manually when Google is
/// blocked), then the copy downloaded into the app's local data dir.
fn find_adb(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join(ADB_NAME), dir.join("platform-tools").join(ADB_NAME)] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let downloaded = tools_dir(app).ok()?.join(ADB_NAME);
    downloaded.is_file().then_some(downloaded)
}

fn http_agent() -> Result<ureq::Agent, String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("ShaniShvilinInstaller/", env!("CARGO_PKG_VERSION")))
        .build())
}

fn check_url(url: &str) -> Result<(), String> {
    if ALLOWED_URL_PREFIXES.iter().any(|p| url.starts_with(p)) {
        Ok(())
    } else {
        Err(format!("URL not allowed: {url}"))
    }
}

struct Fetched {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

/// GET with progress. Non-2xx responses are returned, not treated as errors, so the
/// caller can tell a filter block page from a network failure.
fn fetch(url: &str, mut on_progress: impl FnMut(u64, u64)) -> Result<Fetched, String> {
    check_url(url)?;
    let resp = match http_agent()?.get(url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("download-failed: {e}")),
    };
    let status = resp.status();
    let content_type = resp.header("content-type").unwrap_or("").to_string();
    let total: u64 = resp.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut body = Vec::with_capacity(total as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download-failed: {e}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
        if last_emit.elapsed() > Duration::from_millis(150) {
            on_progress(body.len() as u64, total);
            last_emit = Instant::now();
        }
    }
    on_progress(body.len() as u64, total);
    Ok(Fetched { status, content_type, body })
}

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    total: u64,
}

#[derive(Serialize)]
struct ToolsStatus {
    ready: bool,
    path: Option<String>,
}

#[tauri::command]
fn tools_status(app: AppHandle) -> ToolsStatus {
    let path = find_adb(&app);
    ToolsStatus {
        ready: path.is_some(),
        path: path.map(|p| p.display().to_string()),
    }
}

/// Downloads platform-tools from Google and extracts adb into the app's local data dir.
#[tauri::command]
async fn install_tools(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let fetched = fetch(PLATFORM_TOOLS_URL, |received, total| {
            let _ = app.emit("tools-progress", Progress { received, total });
        })?;
        if fetched.status != 200 {
            return Err(format!("download-failed: HTTP {}", fetched.status));
        }
        if fetched.body.len() < MIN_ZIP_BYTES || fetched.content_type.contains("text/html") || !fetched.body.starts_with(b"PK") {
            return Err("filter-blocked".into());
        }
        let dir = tools_dir(&app)?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(Cursor::new(fetched.body)).map_err(|e| e.to_string())?;
        for name in TOOL_FILES {
            let mut entry = zip
                .by_name(&format!("platform-tools/{name}"))
                .map_err(|e| format!("{name}: {e}"))?;
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            let tmp = dir.join(format!("{name}.part"));
            let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(&data).map_err(|e| e.to_string())?;
            drop(f);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
            fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())?;
        }
        Ok(dir.join(ADB_NAME).display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct AdbOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs adb with a timeout, without flashing a console window.
fn run_adb(adb: &Path, args: &[String], timeout: Duration) -> Result<AdbOutput, String> {
    let mut cmd = Command::new(adb);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("adb: {e}"))?;
    let mut out = child.stdout.take().ok_or("adb: no stdout")?;
    let mut err = child.stderr.take().ok_or("adb: no stderr")?;
    // Drain both pipes on threads so a chatty command cannot block on a full pipe.
    let out_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = out.read_to_end(&mut v);
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = err.read_to_end(&mut v);
        v
    });
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("adb timed out after {}s: {}", timeout.as_secs(), args.join(" ")));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned();
    Ok(AdbOutput { code: status.code().unwrap_or(-1), stdout, stderr })
}

#[tauri::command]
async fn adb(app: AppHandle, args: Vec<String>) -> Result<AdbOutput, String> {
    let path = find_adb(&app).ok_or("adb-missing")?;
    tauri::async_runtime::spawn_blocking(move || run_adb(&path, &args, DEFAULT_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
}

/// Pushes raw bytes (the request body) to `x-remote` on device `x-serial`.
#[tauri::command]
async fn adb_push(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing header {name}"))
    };
    let serial = header("x-serial")?;
    let remote = header("x-remote")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw body".into());
    };
    let bytes = bytes.clone();
    let path = find_adb(&app).ok_or("adb-missing")?;
    let tmp = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("push.tmp");
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = tmp.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        let args = vec![
            "-s".to_string(),
            serial,
            "push".to_string(),
            tmp.display().to_string(),
            remote,
        ];
        let result = run_adb(&path, &args, PUSH_TIMEOUT);
        let _ = fs::remove_file(&tmp);
        let out = result?;
        if out.code != 0 {
            return Err(format!("{}{}", out.stderr, out.stdout).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// HTTPS GET. Response frame: u16 status, u16 content-type length, content-type, body.
#[tauri::command]
async fn http_get(app: AppHandle, url: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = fetch(&url, |received, total| {
            let _ = app.emit("http-progress", Progress { received, total });
        })?;
        let ct = f.content_type.as_bytes();
        let ct_len = ct.len().min(u16::MAX as usize);
        let mut framed = Vec::with_capacity(4 + ct_len + f.body.len());
        framed.extend_from_slice(&f.status.to_be_bytes());
        framed.extend_from_slice(&(ct_len as u16).to_be_bytes());
        framed.extend_from_slice(&ct[..ct_len]);
        framed.extend_from_slice(&f.body);
        Ok(Response::new(framed))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens an https or mailto link in the default browser or mail client.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("only https and mailto links are opened".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]).creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            tools_status,
            install_tools,
            adb,
            adb_push,
            http_get,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while building the installer");

    app.run(|handle, event| {
        // Release the USB device for other tools (the web installer, for example).
        if let RunEvent::Exit = event {
            if let Some(path) = find_adb(handle) {
                let _ = run_adb(&path, &["kill-server".to_string()], Duration::from_secs(5));
            }
        }
    });
}
