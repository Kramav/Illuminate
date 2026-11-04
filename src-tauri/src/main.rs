//! Optional desktop shell. It owns the two native file dialogs and nothing else: conversion is
//! `node illuminate.js`, the same command line, so there is one implementation of the rules.
// ponytail: finds illuminate.js beside this source tree (a cloned repo). Bundling needs a sidecar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;
use tauri_plugin_dialog::DialogExt;

const CLI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../illuminate.js");

/// The Windows "open" dialog. Empty list = cancelled.
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

/// The Windows "save as" dialog, pre-filled with a name from the first input.
#[tauri::command]
async fn pick_output(app: tauri::AppHandle, first_input: String) -> Option<String> {
    let stem = PathBuf::from(first_input).file_stem()?.to_string_lossy().into_owned();
    app.dialog()
        .file()
        .add_filter("Anki / QuickMathPlus deck", &["txt"])
        .set_file_name(format!("{stem}.txt"))
        .blocking_save_file()?
        .into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn convert(files: Vec<String>, out: String) -> Result<String, String> {
    let mut cmd = Command::new("node");
    cmd.arg(CLI).args(&files).arg("--out").arg(&out);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // no console flash
    let run = cmd.output().map_err(|e| format!("could not run node ({e}) — is Node 20+ installed?"))?;
    let said = String::from_utf8_lossy(&run.stderr).trim().to_string();
    if run.status.success() { Ok(said) } else { Err(said) }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_files, pick_output, convert])
        .run(tauri::generate_context!())
        .expect("failed to start Illuminate");
}
