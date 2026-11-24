//! Optional desktop shell. It owns the native dialogs, opening results, and nothing else: conversion
//! is `node illuminate.js`, the same command line, so there is one implementation of the rules. A
//! run with several decks is several CLI calls, driven from the page so it can show progress.
// ponytail: finds illuminate.js beside this source tree (a cloned repo). Bundling needs a sidecar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::Command;
use tauri_plugin_dialog::DialogExt;

const CLI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../illuminate.js");

/// `node illuminate.js <args>` without a console window flashing up.
fn node(args: &[String]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("node");
    cmd.arg(CLI).args(args);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000);
    cmd.output().map_err(|e| format!("could not run node ({e}) — is Node 20+ installed?"))
}

/// The "open" dialog. Empty list = cancelled.
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .add_filter("Slides, documents, PDFs", &["pptx", "docx", "pdf"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// The folder dialog, for where decks are written. None = cancelled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()?
        .into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Which of these paths already exist, so the page can ask before a deck is overwritten.
#[tauri::command]
fn existing(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| Path::new(p).exists()).collect()
}

/// One deck: these inputs merged into `out`. Returns the CLI's stderr either way.
#[tauri::command]
async fn convert(
    files: Vec<String>,
    out: String,
    format: String,
    llm: String,
    model: Option<String>,
) -> Result<String, String> {
    let mut args = files;
    args.extend(["--out".into(), out, "--format".into(), format, "--llm".into(), llm]);
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        args.extend(["--model".into(), m.trim().to_string()]);
    }
    let run = tauri::async_runtime::spawn_blocking(move || node(&args))
        .await
        .map_err(|e| e.to_string())??;
    let said = String::from_utf8_lossy(&run.stderr).trim().to_string();
    if run.status.success() { Ok(said) } else { Err(said) }
}

/// `illuminate --check`: which model providers are ready right now.
#[tauri::command]
async fn check() -> Result<String, String> {
    let run = tauri::async_runtime::spawn_blocking(|| node(&["--check".into()]))
        .await
        .map_err(|e| e.to_string())??;
    Ok(String::from_utf8_lossy(&run.stdout).into_owned())
}

/// Open a file in its default app, or (`reveal`) select it in the file manager.
#[tauri::command]
fn open_path(path: String, reveal: bool) -> Result<(), String> {
    #[cfg(windows)]
    // explorer opens a file with its default app, so no `cmd /C start` and its quoting rules.
    let mut cmd = {
        let mut c = Command::new("explorer");
        if reveal { c.arg(format!("/select,{path}")); } else { c.arg(&path); }
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        if reveal { c.arg("-R"); }
        c.arg(&path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let target = if reveal {
            Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or(path)
        } else {
            path
        };
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_files, pick_folder, existing, convert, check, open_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Illuminate");
}
