use arboard::Clipboard;

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}
