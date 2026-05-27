pub mod commands;
pub mod config;
pub mod db;
pub mod embedding_probe;
pub mod log_parser;
pub mod pi_sessions;
pub mod project_identity;

use std::path::PathBuf;
use std::sync::Mutex;

/// Shared app state holding the resolved database path and dashboard/schema warnings.
pub struct AppState {
    pub db_path: Mutex<Option<PathBuf>>,
    dashboard_schema_warning_version: Mutex<Option<i64>>,
}

impl AppState {
    pub fn new() -> Self {
        let db_path = db::resolve_db_path();
        let state = Self {
            db_path: Mutex::new(db_path),
            dashboard_schema_warning_version: Mutex::new(None),
        };
        if let Ok(path) = state.get_db_path() {
            state.refresh_dashboard_schema_warning(&path);
        }
        state
    }

    pub fn get_db_path(&self) -> Result<PathBuf, String> {
        let path = self
            .db_path
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| {
                "Database not found. Is the Magic Context plugin installed?".to_string()
            })?;
        self.refresh_dashboard_schema_warning(&path);
        Ok(path)
    }

    pub fn dashboard_schema_warning_version(&self) -> Option<i64> {
        self.dashboard_schema_warning_version
            .lock()
            .ok()
            .and_then(|guard| *guard)
    }

    fn refresh_dashboard_schema_warning(&self, path: &PathBuf) {
        if let Ok(Some(version)) = db::dashboard_schema_warning_version_for_path(path) {
            if let Ok(mut guard) = self.dashboard_schema_warning_version.lock() {
                *guard = Some(version);
            }
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
